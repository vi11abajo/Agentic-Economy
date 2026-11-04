// Helpers shared by the tests: the recorded mainnet tapes (test/tapes, made by test/record.mjs). Not part of the CLI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { fromTape, type Chain, type Frame, type Tape, type TxReq } from "./chain.js";

export const WALLET = "0x46441dc99f8000959e9c48cf2a01a018d131d3bb" as Address;
export const PMUSK_MARKET = "0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f" as Address;
export const HIDDEN_HOP = "0x30bebe432ff53c9b6ed28dd9daf125902cbabb56" as Address;
export const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0" as Address;
export const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815" as Address;
export const PROSPER_ROUTER = "0x63ffadf944583d8e4fdc30144efdfe3bdc2122f5" as Address;
export const DEAD = "0x000000000000000000000000000000000000dead" as Address;

export type Recorded = { tx: TxReq; block: bigint; chain: Chain; tape: Tape; frame: Frame };

export function recorded(name: "pmusk-buy" | "pros-send" | "usdc-approve-max" | "too-big-buy"): Recorded {
  const file = JSON.parse(readFileSync(join(process.cwd(), "test", "tapes", `${name}.json`), "utf8")) as { request: { from: Address; to: Address; data: Hex; value: string }; block: string; tape: Tape };
  const tx: TxReq = { ...file.request, value: BigInt(file.request.value) };
  const traceKey = Object.keys(file.tape).find((k) => k.startsWith("trace "))!;
  return { tx, block: BigInt(file.block), chain: fromTape(file.tape), tape: file.tape, frame: file.tape[traceKey] as Frame };
}
