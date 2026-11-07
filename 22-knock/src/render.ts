// The words a person reads before anything gets signed. Plain text, the payment first, then every check with its
// mark, then a line that says nothing has been signed. The JSON comes after this, never inside it.
import { getAddress } from "viem";
import type { Built } from "./plan.js";
import type { Verdict } from "./names.js";

const MARK: Record<Verdict["level"], string> = { PASS: "ok  ", WARN: "warn", BLOCK: "STOP" };

export function renderVerdicts(vs: Verdict[]): string {
  return vs.map((v) => `  ${MARK[v.level]}  ${v.says}`).join("\n");
}

export function renderSummary(b: Built): string {
  const p = b.plan;
  if (!p) {
    return [`Not prepared: ${b.intent.amount} ${b.intent.token} to ${b.intent.recipientKind === "self" ? "yourself" : b.intent.recipient}`, "", "checks", renderVerdicts(b.verdicts), "", "STOPPED: nothing was prepared, nothing was signed."].join("\n");
  }
  const toLine = p.name ? `${p.to} (${p.name}, resolved on Ethereum; on Pharos: ${p.recipient})` : `${p.to} (${p.recipient})`;
  const lines = [
    `Send ${p.amount} ${p.token.symbol}${p.to === p.from ? " to yourself" : ""}`,
    `  from        ${p.from}`,
    `  to          ${toLine}`,
    `  token       ${p.token.address === "native" ? "PROS, the native coin" : `${getAddress(p.token.address)} (${p.token.source === "read from chain" ? "read from chain" : "Pharos docs token list"})`}`,
    `  amount      ${p.amount} ${p.token.symbol} = ${p.raw} base units`,
    `  network     Pharos mainnet, chain 1672`,
    `  max fee     ${p.maxFeePros} PROS (gas limit ${BigInt(p.tx.gas)})`,
    `  after it    you'd hold ${p.balanceAfter}`,
    `  simulated   at block ${p.block}, from your address`,
    "",
    "checks",
    renderVerdicts(p.verdicts),
    "",
  ];
  if (p.byAuthorization) {
    const until = new Date(p.byAuthorization.validBefore * 1000).toISOString().replace(".000Z", "Z");
    lines.push(
      `Or pay by signature: sign a USDC ReceiveWithAuthorization instead of a transaction. Only ${p.byAuthorization.payee === p.from ? "you (as the payee)" : "the payee"} can submit it, and it expires at ${until}.`,
      "",
    );
  }
  lines.push("UNSIGNED: knock holds no key. Nothing has been signed or sent; your wallet does that if you approve.");
  return lines.join("\n");
}
