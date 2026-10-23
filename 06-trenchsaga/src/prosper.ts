// Prosper (pros-per.xyz) on Pharos Pacific Mainnet: the contracts a rotation touches. The Prosper contracts
// aren't verified on the explorer; the function names come from the Prosper web app and were checked with
// real calls (see 05-trenchscope). Router and WPROS addresses match https://api.pros-per.xyz/api/v1/deployment.
import { parseAbi, type Address } from "viem";

export const CHAIN_ID = 1672;
export const RPC_URL = "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";

export const ROUTER: Address = "0x63FfADf944583D8e4Fdc30144EFdfe3bdC2122f5";
export const WPROS: Address = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0";

export const marketAbi = parseAbi([
  "function pToken() view returns (address)",
  "function phase() view returns (uint8)",
  "function quoteBuy(uint256 grossAmountIn) view returns (uint256 usedGross, uint256 fee, uint256 netAmountIn, uint256 pTokenOut)",
  "function quoteSell(uint256 pTokenIn) view returns (uint256 grossWrappedNativeOut, uint256 fee, uint256 netWrappedNativeOut)",
]);

export const routerAbi = parseAbi([
  "function buyInnerNative(address market, uint256 minPTokenOut, uint256 deadline) payable returns (uint256 pTokenOut, uint256 nativeUsed)",
  "function sellInner(address market, uint256 pTokenIn, uint256 minOut, uint256 deadline, bool nativeOut) returns (uint256 amountOut)",
]);

export const curveEvents = parseAbi([
  "event Bought(address indexed router, address indexed trader, uint256 grossIn, uint256 netIn, uint256 pTokenOut, uint256 fee)",
  "event Sold(address indexed router, address indexed trader, uint256 pTokenIn, uint256 grossOut, uint256 netOut, uint256 fee, bool toNative)",
]);

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const wprosAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function balanceOf(address) view returns (uint256)",
]);
