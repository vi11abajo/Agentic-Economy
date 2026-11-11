// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IProsperFactory {
    // (id, pToken, market, buyback, share, cap, scale); all zeros for a vault Prosper did not deploy
    function deploymentOf(address vault)
        external
        view
        returns (uint256, address, address, address, address, uint256, uint256);
}

interface IProsperMarket {
    function r25Vault() external view returns (address);
    function phase() external view returns (uint8);
    function realWrappedNativeReserve() external view returns (uint256);
    function buyNative(uint256 minOut, uint256 deadline, address recipient) external payable returns (uint256, uint256);
}

interface IBeacon {
    function implementation() external view returns (address);
}

/// @title ProsperionGate
/// @notice A buy button for Prosper launches that checks the market before your PROS goes in.
/// You set your own limits once; every buy then has to pass them, in the same transaction, or nothing happens.
/// The gate holds nothing: the pTokens go from the market straight to you (checked on a mainnet fork), and any PROS
/// the market hands back is forwarded to you before the call ends. No owner, no admin, no upgrade.
contract ProsperionGate {
    struct Limits {
        uint128 maxPerBuy; // PROS per buy
        uint128 maxPerDay; // PROS per UTC day
        uint128 maxReserveBefore; // "first in" means: at most this much PROS already in the curve
        address acceptedMarketImpl; // the market code you agreed to; if Prosper upgrades it, you decide again
    }

    IProsperFactory public immutable factory;
    IBeacon public immutable marketBeacon;

    mapping(address => Limits) public limitsOf;
    mapping(address => mapping(uint256 => uint256)) public spentOn; // user => day => PROS

    bool private buying;

    event LimitsSet(address indexed user, Limits limits);
    event Bought(address indexed user, address indexed market, uint256 value, uint256 out);

    error NoLimits();
    error NotGenuine(address market);
    error WrongPhase(uint256 phase);
    error NotFirst(uint256 reserve, uint256 maxReserveBefore);
    error ImplChanged(address current, address accepted);
    error OverPerBuy(uint256 value, uint256 max);
    error OverPerDay(uint256 spentToday, uint256 max);
    error ForwardFailed();
    error NoStrayPros();

    constructor(address factory_, address marketBeacon_) {
        factory = IProsperFactory(factory_);
        marketBeacon = IBeacon(marketBeacon_);
    }

    function setLimits(Limits calldata l) external {
        limitsOf[msg.sender] = l;
        emit LimitsSet(msg.sender, l);
    }

    function buy(address market, uint256 minOut, uint256 deadline) external payable returns (uint256 out) {
        Limits memory l = limitsOf[msg.sender];
        if (l.maxPerBuy == 0) revert NoLimits();

        // Real Prosper market? Ask the market for its vault, then ask the factory which market it made for that vault.
        // Low-level on purpose: try/catch does not catch "no code at that address" or an answer that is not an address.
        (bool ok, bytes memory ret) = market.staticcall(abi.encodeCall(IProsperMarket.r25Vault, ()));
        if (!ok || ret.length != 32 || market.code.length == 0) revert NotGenuine(market);
        address vault = abi.decode(ret, (address));
        (,, address listed,,,,) = factory.deploymentOf(vault);
        if (listed != market) revert NotGenuine(market);

        uint256 phase = IProsperMarket(market).phase();
        if (phase != 0) revert WrongPhase(phase);

        uint256 reserve = IProsperMarket(market).realWrappedNativeReserve();
        if (reserve > l.maxReserveBefore) revert NotFirst(reserve, l.maxReserveBefore);

        address impl = marketBeacon.implementation();
        if (impl != l.acceptedMarketImpl) revert ImplChanged(impl, l.acceptedMarketImpl);

        if (msg.value > l.maxPerBuy) revert OverPerBuy(msg.value, l.maxPerBuy);
        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentOn[msg.sender][day];
        if (spent + msg.value > l.maxPerDay) revert OverPerDay(spent, l.maxPerDay);
        spentOn[msg.sender][day] = spent + msg.value;

        buying = true;
        (out,) = IProsperMarket(market).buyNative{value: msg.value}(minOut, deadline, msg.sender);
        buying = false;

        // If the curve could not take all of it, the market refunds us; it goes back to the buyer now.
        uint256 left = address(this).balance;
        if (left > 0) {
            spentOn[msg.sender][day] -= left;
            (bool ok,) = msg.sender.call{value: left}("");
            if (!ok) revert ForwardFailed();
        }
        emit Bought(msg.sender, market, msg.value - left, out);
    }

    /// @dev Only a refund from a market in the middle of a buy is welcome; anything else bounces.
    receive() external payable {
        if (!buying) revert NoStrayPros();
    }
}
