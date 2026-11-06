import { parseAbi } from "viem";

export const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const wpros = parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]);

export const erc4626 = parseAbi([
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

// Faroo stPROS on top of ERC-4626. Names of the two entry points match their selectors (0xb4430b99, 0x2e6cb841),
// the selectors are what real users call in the explorer's history of the contract.
export const stpros = parseAbi(["function depositWithPROS() payable", "function withdrawCompleteToPROS()"]);

// Aave V3.0 pool and the default interest-rate strategy, the version all three Pharos forks answer to.
export const aavePool = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function getReserveNormalizedIncome(address asset) view returns (uint256)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
]);

export const rateStrategy = parseAbi([
  "function calculateInterestRates((uint256 unbacked, uint256 liquidityAdded, uint256 liquidityTaken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 averageStableBorrowRate, uint256 reserveFactor, address reserve, address aToken) params) view returns (uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate)",
]);

export const stableDebt = parseAbi(["function getAverageStableRate() view returns (uint256)"]);

export const feed = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
