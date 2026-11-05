// Every read receipts ever makes, in one place. Selectors are unique across the list, which lets the test fake
// decode any call without being told which contract it pretends to be.
import { parseAbi } from "viem";

export const READS = parseAbi([
  // ERC-20
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  // ERC-4626 / ERC-7540
  "function asset() view returns (address)",
  "function share() view returns (address)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function pendingRedeemRequest(uint256 requestId, address controller) view returns (uint256)",
  "function claimableRedeemRequest(uint256 requestId, address controller) view returns (uint256)",
  "function pendingDepositRequest(uint256 requestId, address controller) view returns (uint256)",
  "function claimableDepositRequest(uint256 requestId, address controller) view returns (uint256)",
  // Uniswap V2 style pairs (Prosper V2 too)
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  // Prosper bonding curve market
  "function pToken() view returns (address)",
  "function phase() view returns (uint8)",
  "function quoteSell(uint256 pTokenIn) view returns (uint256 grossWrappedNativeOut, uint256 fee, uint256 netWrappedNativeOut)",
  // Morpho Blue
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  // Prosper V2 factory
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  // Chainlink
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export type ReadName = (typeof READS)[number]["name"];
