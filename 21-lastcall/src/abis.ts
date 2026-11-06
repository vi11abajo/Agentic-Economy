// The slices of each protocol's ABI that lastcall actually touches. Kept as human-readable signatures so it's
// easy to check them against the contracts on the explorer.
import { parseAbi } from "viem";

export const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// Aave V3 and its forks (Avalon, OpenFi, Zona all answer to these).
export const aavePool = parseAbi([
  "function getReservesList() view returns (address[])",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function getUserConfiguration(address user) view returns ((uint256 data))",
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
]);

export const aaveProvider = parseAbi([
  "function getPriceOracle() view returns (address)",
  "function getPoolConfigurator() view returns (address)",
  "function getACLManager() view returns (address)",
  "function owner() view returns (address)",
]);

export const aaveOracle = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
]);

export const rateStrategy = parseAbi([
  "function calculateInterestRates((uint256 unbacked, uint256 liquidityAdded, uint256 liquidityTaken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 averageStableBorrowRate, uint256 reserveFactor, address reserve, address aToken) params) view returns (uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate)",
]);

export const stableDebt = parseAbi(["function getAverageStableRate() view returns (uint256)"]);

const MP = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";
const MK = "(uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)";

export const morpho = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  `function accrueInterest(${MP} marketParams)`,
  `function repay(${MP} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function supplyCollateral(${MP} marketParams, uint256 assets, address onBehalf, bytes data)`,
]);

export const morphoIrm = parseAbi([`function borrowRateView(${MP} marketParams, ${MK} market) view returns (uint256)`]);

export const morphoOracle = parseAbi(["function price() view returns (uint256)"]);

// Who holds the keys to a pool. A Gnosis Safe answers the first two, an OZ timelock the third.
export const safe = parseAbi([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getMinDelay() view returns (uint256)",
]);

// Our own helper, see contracts/Runner.sol.
export const runner = parseAbi(["function run(address[] t, bytes[] d) returns (bytes[] out)"]);
