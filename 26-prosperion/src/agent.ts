// The only door to the agent. Hermes listens on 127.0.0.1:8642 on the same box; the key stays in the server's
// .env and never reaches a browser. What the page tells us about the visitor's wallet goes in front of the chat as a
// short note, so the agent can give OKX, Rabby or MetaMask instructions that actually match.
import type { Address } from "viem";

export const HERMES_URL = process.env.HERMES_URL ?? "http://127.0.0.1:8642";
const HERMES_KEY = () => process.env.HERMES_API_KEY ?? "";

export interface WalletEnv {
  provider?: string;
  rdns?: string;
  inWalletBrowser?: "okx" | "metamask" | "rabby" | null;
  desktopExtension?: boolean;
  chainId?: number;
  address?: Address;
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function walletNote(env: WalletEnv): string {
  const where = env.inWalletBrowser
    ? `inside the ${env.inWalletBrowser} wallet's own browser on a phone`
    : env.desktopExtension
      ? `on a desktop browser with a wallet extension (${env.provider ?? env.rdns ?? "unknown"})`
      : "in a browser with no wallet detected";
  return [
    `Visitor context from the page (not from the visitor's words): they are ${where}.`,
    env.chainId ? `Wallet chain id: ${env.chainId}${env.chainId === 1672 ? " (Pharos)" : " (not Pharos; they will need to switch)"}.` : "",
    env.address ? `Connected address: ${env.address}.` : "No address connected.",
    !env.inWalletBrowser && !env.desktopExtension
      ? "If they want to sign something, ask which wallet they use on their phone before giving steps."
      : "",
  ].filter(Boolean).join(" ");
}

const clean = (msgs: ChatMessage[]): ChatMessage[] =>
  msgs
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

/** Streams a chat turn from Hermes. Throws if Hermes cannot be reached. */
export async function chatAgent(messages: ChatMessage[], env: WalletEnv, sessionKey: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${HERMES_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${HERMES_KEY()}`,
      "x-hermes-session-key": sessionKey,
    },
    body: JSON.stringify({
      model: "hermes-agent",
      stream: true,
      messages: [{ role: "system", content: walletNote(env) }, ...clean(messages)],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`agent answered ${res.status}`);
  return res;
}

/** One-shot question, used for launch dossiers. */
export async function askAgent(prompt: string, sessionKey = "prosperion-dossier"): Promise<string> {
  const res = await fetch(`${HERMES_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${HERMES_KEY()}`, "x-hermes-session-key": sessionKey },
    body: JSON.stringify({ model: "hermes-agent", stream: false, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`agent answered ${res.status}`);
  const j = (await res.json()) as { choices: { message: { content: string }; finish_reason: string }[] };
  const c = j.choices?.[0];
  if (!c || c.finish_reason === "error" || c.finish_reason === "cancelled") throw new Error(`agent turn ${c?.finish_reason ?? "empty"}`);
  return c.message.content;
}
