// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProsperionGate} from "../src/ProsperionGate.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

interface IMarketView {
    function realWrappedNativeReserve() external view returns (uint256);
    function pToken() external view returns (address);
}

// Runs against a fork of Pharos mainnet: forge test --fork-url https://rpc.pharos.xyz
// Real markets, real factory, real beacon. Nothing here is mocked except the fake market.
contract ProsperionGateTest is Test {
    address constant FACTORY = 0xEfdbb0eA7647B0e21AEf7A3b7a5D6A632c3116C8;
    address constant BEACON = 0x30BeBe432fF53c9B6ED28Dd9DAf125902CbABB56;
    address constant PBOT_MARKET = 0x94228EB493173E75a12e76E667bfe9b0939aae64; // on the curve
    address constant DOG_MARKET = 0x3f603E94053a6F251B4a98c17e26c3e8F65f2BD7; // graduated
    address constant MARKET_IMPL = 0xb05749a8Cc5Dd1205Bc36326Cf94A2cA83f7D672;

    ProsperionGate gate;
    address user = makeAddr("user");
    uint256 reserveNow;

    function setUp() public {
        gate = new ProsperionGate(FACTORY, BEACON);
        vm.deal(user, 100 ether);
        reserveNow = IMarketView(PBOT_MARKET).realWrappedNativeReserve();
    }

    function limits(uint128 perBuy, uint128 perDay, uint128 maxReserve, address impl)
        internal
        pure
        returns (ProsperionGate.Limits memory)
    {
        return ProsperionGate.Limits(perBuy, perDay, maxReserve, impl);
    }

    function _setNormal() internal {
        vm.prank(user);
        gate.setLimits(limits(1 ether, 2 ether, uint128(reserveNow), MARKET_IMPL));
    }

    function test_buyWithoutLimitsIsRefused() public {
        vm.prank(user);
        vm.expectRevert(ProsperionGate.NoLimits.selector);
        gate.buy{value: 0.01 ether}(PBOT_MARKET, 0, block.timestamp + 60);
    }

    function test_fakeMarketIsRefused() public {
        _setNormal();
        address fake = address(new FakeMarket());
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ProsperionGate.NotGenuine.selector, fake));
        gate.buy{value: 0.01 ether}(fake, 0, block.timestamp + 60);
    }

    function test_plainWalletIsNotAMarket() public {
        _setNormal();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ProsperionGate.NotGenuine.selector, user));
        gate.buy{value: 0.01 ether}(user, 0, block.timestamp + 60);
    }

    function test_graduatedMarketIsRefused() public {
        _setNormal();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ProsperionGate.WrongPhase.selector, 2));
        gate.buy{value: 0.01 ether}(DOG_MARKET, 0, block.timestamp + 60);
    }

    function test_notFirstAnymoreIsRefused() public {
        vm.prank(user);
        gate.setLimits(limits(1 ether, 2 ether, 0, MARKET_IMPL));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ProsperionGate.NotFirst.selector, reserveNow, 0));
        gate.buy{value: 0.01 ether}(PBOT_MARKET, 0, block.timestamp + 60);
    }

    function test_changedMarketCodeIsRefused() public {
        address other = address(0xC0DE);
        vm.prank(user);
        gate.setLimits(limits(1 ether, 2 ether, uint128(reserveNow), other));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ProsperionGate.ImplChanged.selector, MARKET_IMPL, other));
        gate.buy{value: 0.01 ether}(PBOT_MARKET, 0, block.timestamp + 60);
    }

    function test_overPerBuyIsRefused() public {
        _setNormal();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ProsperionGate.OverPerBuy.selector, 1.5 ether, 1 ether));
        gate.buy{value: 1.5 ether}(PBOT_MARKET, 0, block.timestamp + 60);
    }

    function test_overPerDayIsRefused() public {
        vm.prank(user);
        // generous reserve bound: the first buy raises the reserve and we only want the day cap to bite here
        gate.setLimits(limits(1 ether, 1.5 ether, type(uint128).max, MARKET_IMPL));
        vm.prank(user);
        gate.buy{value: 1 ether}(PBOT_MARKET, 0, block.timestamp + 60);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ProsperionGate.OverPerDay.selector, 1 ether, 1.5 ether));
        gate.buy{value: 1 ether}(PBOT_MARKET, 0, block.timestamp + 60);
        // next day the cap resets
        vm.warp(block.timestamp + 1 days);
        vm.prank(user);
        gate.buy{value: 1 ether}(PBOT_MARKET, 0, block.timestamp + 60);
    }

    function test_happyPathTokensLandWithTheUserAndTheGateKeepsNothing() public {
        _setNormal();
        address pToken = IMarketView(PBOT_MARKET).pToken();
        uint256 before = IERC20(pToken).balanceOf(user);
        vm.expectEmit(true, true, false, false, address(gate));
        emit ProsperionGate.Bought(user, PBOT_MARKET, 0.01 ether, 0);
        vm.prank(user);
        uint256 out = gate.buy{value: 0.01 ether}(PBOT_MARKET, 1, block.timestamp + 60);
        assertGt(out, 0);
        assertEq(IERC20(pToken).balanceOf(user) - before, out);
        assertEq(IERC20(pToken).balanceOf(address(gate)), 0);
        assertEq(address(gate).balance, 0);
    }

    function test_gateRefusesStrayPros() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(gate).call{value: 1 ether}("");
        assertFalse(ok);
    }
}

// Copies the getters a real market has, but the factory never deployed it.
contract FakeMarket {
    function r25Vault() external pure returns (address) {
        return 0x251a68B711EA3967B434EefCA49D43cD133Ef3ee; // pBOT's real vault
    }

    function phase() external pure returns (uint8) {
        return 0;
    }

    function realWrappedNativeReserve() external pure returns (uint256) {
        return 0;
    }

    function buyNative(uint256, uint256, address) external payable returns (uint256, uint256) {
        return (1, msg.value);
    }
}
