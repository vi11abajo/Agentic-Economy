// The addresses and ABI bits onego needs on Pharos mainnet. Every address here was checked on chain on
// 2026-11-03 (see docs/superpowers/specs/2026-11-03-onego-design.md for how).
import { parseAbi, type Address } from "viem";

export const CHAIN_ID = 1672;
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const USDC: Address = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
export const WPROS: Address = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0";
export const V2_FACTORY: Address = "0x9343d6f1a7058a9ffd43028666db23cfce3e0d1e";

// Where the balances live, so a simulation can hand a wallet the money it really has (or a "what if" amount).
export const USDC_SLOT = 9n;
export const WPROS_SLOT = 3n;
export const USDC_DECIMALS = 6;

// EIP-3009 lets the payer sign "pay X to Y" off chain; whoever submits it can only make that exact payment.
export const USDC_DOMAIN = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC } as const;

// Graduated Prosper tokens trade in V2 pools against WPROS.
export const POOL_TOKENS: Record<string, Address> = {
  pTACO: "0x52ACdEb49056518578c7af788aE2C367132E2DB5",
  pCARR: "0xd6d6C5B012a81d793DEAd821D1DD05446E1118c5",
};

// Tokens still on their bonding curve: bought from the market contract, which takes a recipient.
export const CURVE_MARKETS: Record<string, { token: Address; market: Address }> = {
  pMusk: { token: "0xE318ac4113324841265d270Dc2393f1Bf742A7f8", market: "0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f" },
};

export const multicall3Abi = parseAbi([
  "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
export const wprosAbi = parseAbi(["function deposit() payable"]);
export const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
]);
export const factoryAbi = parseAbi(["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"]);
export const marketAbi = parseAbi([
  "function quoteBuy(uint256 amount) view returns (uint256 usedGross, uint256 fee, uint256 netIn, uint256 pTokenOut)",
  "function buyNative(uint256 minOut, uint256 deadline, address recipient) payable",
  "function phase() view returns (uint8)",
  "function endsAt() view returns (uint256)",
  "function pToken() view returns (address)",
]);
export const usdcAuthAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);
