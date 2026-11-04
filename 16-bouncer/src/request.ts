// What the agent asks for, turned into the one exact unsigned transaction bouncer will trace, judge and (on ALLOW)
// sign. The agent never hands over a signed tx: whatever gets judged is what gets sent, byte for byte.
import { existsSync, readFileSync } from "node:fs";
import { encodeFunctionData, formatUnits, isAddress, isHex, maxUint256, parseAbi, parseAbiItem, type AbiFunction, type Address, type Hex } from "viem";
import { toUnits, type Policy } from "./policy.js";

export type Request = { words: string; tx: { to: Address; data: Hex; value: bigint } };
type Parsed = { request: Request } | { problem: string };

const USDC = { address: "0xc879c018db60520f4355c26ed1a6d572cdac1815" as Address, decimals: 6 };
const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function approve(address spender, uint256 amount) returns (bool)"]);

export const USAGE = `requests:
  pros <to> <amount>                              send PROS
  token <USDC|0x token> <to> <amount>             send a token
  approve <USDC|0x token> <spender> <amount|max>  let a contract spend a token
  call <contract> "<fn(types)>" [args...] [--value <PROS>]   call any contract function
  raw <to> <0x data> [--value <PROS>]             a ready calldata
  --tx <file.json>                                {"to", "data", "value" (wei)} built by another tool`;

const addressOf = (text: string | undefined): Address | null => (text && isAddress(text, { strict: false }) ? (text.toLowerCase() as Address) : null);

/** A token by name or address, with the decimals bouncer needs to read amounts: USDC built in, others from the policy. */
function tokenOf(text: string, policy: Policy): { address: Address; decimals: number; name: string } | string {
  if (text.toUpperCase() === "USDC") return { ...USDC, name: "USDC" };
  const byName = policy.spend[text];
  if (byName?.token) return { address: byName.token, decimals: byName.decimals, name: text };
  const address = addressOf(text);
  if (!address) return `"${text}" is neither a token address nor a token named in the policy's spend section`;
  if (address === USDC.address) return { ...USDC, name: "USDC" };
  const named = Object.entries(policy.spend).find(([, cap]) => cap.token === address);
  if (!named) return `bouncer doesn't know the decimals of ${address}; add it to the policy's spend section (token + decimals) first`;
  return { address, decimals: named[1].decimals, name: named[0] };
}

const positive = (text: string | undefined, decimals: number, what: string): bigint | string => {
  const n = toUnits(text, decimals);
  if (n === null) return `${what} amount "${text ?? ""}" must be a plain decimal number with at most ${decimals} decimals`;
  if (n === 0n) return `${what} amount is 0: nothing to do`;
  return n;
};

function valueFlag(argv: string[]): { rest: string[]; value: bigint } | string {
  const i = argv.indexOf("--value");
  if (i < 0) return { rest: argv, value: 0n };
  const v = positive(argv[i + 1], 18, "--value PROS");
  if (typeof v === "string") return v;
  return { rest: [...argv.slice(0, i), ...argv.slice(i + 2)], value: v };
}

// Command-line words into ABI values: numbers become bigints, true/false booleans, everything else stays text.
const coerce = (type: string, text: string): unknown => (/^u?int/.test(type) ? BigInt(text) : type === "bool" ? text === "true" : text);

export function parseRequest(argv: string[], policy: Policy): Parsed {
  const [kind, ...args] = argv;
  const bad = (problem: string): Parsed => ({ problem });
  switch (kind) {
    case "pros": {
      const to = addressOf(args[0]);
      if (!to) return bad(`"${args[0] ?? ""}" is not an address`);
      const value = positive(args[1], 18, "PROS");
      if (typeof value === "string") return bad(value);
      return { request: { words: `send ${formatUnits(value, 18)} PROS to ${to}`, tx: { to, data: "0x", value } } };
    }
    case "token":
    case "approve": {
      const token = tokenOf(args[0] ?? "", policy);
      if (typeof token === "string") return bad(token);
      const who = addressOf(args[1]);
      if (!who) return bad(`"${args[1] ?? ""}" is not an address`);
      if (kind === "approve") {
        const amount = args[2] === "max" ? maxUint256 : toUnits(args[2], token.decimals);
        if (amount === null) return bad(`approve amount "${args[2] ?? ""}" must be "max" or a plain decimal number with at most ${token.decimals} decimals`);
        const words = `approve ${who} to spend ${amount === maxUint256 ? "unlimited" : formatUnits(amount, token.decimals)} ${token.name}`;
        return { request: { words, tx: { to: token.address, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [who, amount] }), value: 0n } } };
      }
      const amount = positive(args[2], token.decimals, token.name);
      if (typeof amount === "string") return bad(amount);
      return { request: { words: `send ${formatUnits(amount, token.decimals)} ${token.name} to ${who}`, tx: { to: token.address, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [who, amount] }), value: 0n } } };
    }
    case "call":
    case "raw": {
      const v = valueFlag(args);
      if (typeof v === "string") return bad(v);
      const [target, second, ...rest] = v.rest;
      const to = addressOf(target);
      if (!to) return bad(`"${target ?? ""}" is not an address`);
      const attached = v.value ? ` with ${formatUnits(v.value, 18)} PROS` : "";
      if (kind === "raw") {
        if (!second || !isHex(second)) return bad(`calldata "${second ?? ""}" must be 0x hex`);
        return { request: { words: `call ${to} with ${second.slice(0, 10)}…${attached}`, tx: { to, data: second.toLowerCase() as Hex, value: v.value } } };
      }
      let fn: AbiFunction;
      try {
        fn = parseAbiItem(`function ${second}`) as AbiFunction;
      } catch {
        return bad(`"${second ?? ""}" isn't a function signature like "buyNative(uint256,uint256,address)"`);
      }
      if (rest.length !== fn.inputs.length) return bad(`${fn.name} takes ${fn.inputs.length} arguments, got ${rest.length}`);
      try {
        const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: fn.inputs.map((p, i) => coerce(p.type, rest[i])) });
        return { request: { words: `call ${fn.name}(${rest.join(", ")}) on ${to}${attached}`, tx: { to, data, value: v.value } } };
      } catch (err) {
        return bad(`couldn't encode ${fn.name}: ${(err as Error).message.split("\n")[0]}`);
      }
    }
    case "--tx": {
      const file = args[0];
      if (!file || !existsSync(file)) return bad(`no transaction file at ${file ?? "(none given)"}`);
      let j: { to?: string; data?: string; value?: string | number };
      try {
        j = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        return bad(`${file} isn't valid JSON: ${(err as Error).message}`);
      }
      const to = addressOf(j.to);
      if (!to) return bad(`"to" in ${file} is not an address`);
      const data = (j.data ?? "0x") as string;
      if (!isHex(data)) return bad(`"data" in ${file} must be 0x hex`);
      if (j.value !== undefined && !/^\d+$/.test(String(j.value))) return bad(`"value" in ${file} must be a whole number of wei`);
      const value = BigInt(j.value ?? 0);
      return { request: { words: `the transaction in ${file} (to ${to})`, tx: { to, data: data.toLowerCase() as Hex, value } } };
    }
    default:
      return bad(`unknown request "${kind ?? ""}"\n${USAGE}`);
  }
}
