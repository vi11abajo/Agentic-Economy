// Reading the sentence. No model here, on purpose: the agent that runs the skill does the talking, and this file
// only pulls out what the words actually say. Whenever a reading would need a guess ("1,000" is a thousand in
// London and one in Berlin, "$5" isn't a token, "0x4644...D3Bb" isn't an address), it returns a question
// instead, and the user's answer comes back in through `answers`.

export interface Intent {
  amount: string;
  /** A symbol in upper case ("USDC") or a token contract address the user typed. */
  token: string;
  recipient: string;
  recipientKind: "address" | "name" | "self";
}

export interface Question {
  field: "amount" | "token" | "recipient" | "split";
  ask: string;
}

interface Reading {
  amount?: string;
  token?: string;
  recipient?: string;
  recipientKind?: Intent["recipientKind"];
  questions: Question[];
}

const FULL_ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const CUT_ADDRESS = /0x[0-9a-fA-F]{2,39}(?:\.{2,3}|…)[0-9a-fA-F]*|\b0x[0-9a-fA-F]{2,39}\b(?![0-9a-fA-F])/;
const ENS_NAME = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.eth\b/gi;
const SELF = /\b(?:to|for)\s+(?:me|myself|my\s+(?:own\s+)?wallet)\b|\bmyself\b/i;
const NUMBER = /(\$\s?)?(?<![\w.])(\d+(?:[.,]\d+)*)(\s?[kKmM](?![a-zA-Z]))?/g;
const VAGUE_AMOUNT = /\b(all|everything|entire|whole|half|max|maximum|rest)\b/i;
const FIAT = /\b(dollars?|bucks|usd|bucks)\b/i;
const NOT_A_TICKER = new Set(["to", "for", "and", "of", "from", "worth", "in", "on", "the", "my", "me", "please", "dollars", "dollar", "bucks", "usd", "k", "m", "eth"]);
const KNOWN_TICKERS = /\b(pros|phrs|wpros|usdc|link|weth|usdt)\b/i;

/** "1.5" x 10^3 -> "1500", done on the digits so nothing turns into 1499.9999. */
function shift(decimal: string, places: number): string {
  const [whole, frac = ""] = decimal.split(".");
  const padded = frac.padEnd(places, "0");
  const joined = (whole + padded.slice(0, places)).replace(/^0+(?=\d)/, "");
  const rest = padded.slice(places).replace(/0+$/, "");
  return rest ? `${joined}.${rest}` : joined;
}

/** One number as written. Returns the plain decimal, or why it can't be read without asking. */
function readNumber(written: string, suffix: string): { value: string } | { unsure: string } {
  const commas = (written.match(/,/g) ?? []).length;
  const dots = (written.match(/\./g) ?? []).length;
  let plain: string;
  if (commas && dots) {
    // 1,250.50 is English; 1.250,50 is the continental way round. We take the first and ask about the second.
    if (written.lastIndexOf(".") > written.lastIndexOf(",")) plain = written.replace(/,/g, "");
    else return { unsure: `"${written}": is that ${written.replace(/\./g, "").replace(",", ".")}? Write it with a dot for decimals and no thousands separator.` };
  } else if (commas) {
    if (/^\d{1,3}(,\d{3}){2,}$/.test(written)) plain = written.replace(/,/g, "");
    else if (/^\d{1,3},\d{3}$/.test(written))
      return { unsure: `"${written}": a thousand or one point zero? Write ${written.replace(",", "")} or ${written.replace(",", ".")} so I don't guess.` };
    else return { unsure: `"${written}": is the comma a decimal point? Write it as ${written.replace(",", ".")} if so.` };
  } else if (dots > 1) {
    if (/^\d{1,3}(\.\d{3})+$/.test(written)) plain = written.replace(/\./g, "");
    else return { unsure: `"${written}" has more than one dot; write the amount as a plain number.` };
  } else if (dots === 1 && /^\d{1,3}\.\d{3}$/.test(written) && !suffix) {
    return { unsure: `"${written}": a thousand or one point zero? Write ${written.replace(".", "")} or ${written.replace(/0+$/, "").replace(/\.$/, ".0")} so I don't guess.` };
  } else plain = written;
  const s = suffix.trim().toLowerCase();
  return { value: s === "k" ? shift(plain, 3) : s === "m" ? shift(plain, 6) : plain };
}

function read(text: string): Reading {
  const out: Reading = { questions: [] };
  const recipients: { value: string; kind: Intent["recipientKind"] }[] = [];
  let tokenAddress: string | undefined;
  let rest = text;

  for (const m of text.matchAll(FULL_ADDRESS)) {
    // An address right after a number is the thing being sent ("3 0x52c4... to ..."); any other one is a payee.
    const before = text.slice(0, m.index).trimEnd();
    if (/\d[kKmM]?$/.test(before) && !tokenAddress) tokenAddress = m[0];
    else recipients.push({ value: m[0], kind: "address" });
    rest = rest.replace(m[0], " ");
  }
  for (const m of rest.matchAll(ENS_NAME)) {
    recipients.push({ value: m[0].toLowerCase(), kind: "name" });
    rest = rest.replace(m[0], " ");
  }
  if (CUT_ADDRESS.test(rest)) {
    out.questions.push({ field: "recipient", ask: "That address looks shortened. Paste the full 42-character address (0x followed by 40 hex characters)." });
    rest = rest.replace(CUT_ADDRESS, " ");
  }
  if (SELF.test(rest)) recipients.push({ value: "self", kind: "self" });

  const amounts: string[] = [];
  let dollars = FIAT.test(rest);
  let ticker: string | undefined = tokenAddress;
  for (const m of rest.matchAll(NUMBER)) {
    if (m[1]) dollars = true;
    const n = readNumber(m[2], m[3] ?? "");
    if ("unsure" in n) out.questions.push({ field: "amount", ask: n.unsure });
    else amounts.push(n.value);
    const after = rest.slice(m.index! + m[0].length).match(/^\s*([A-Za-z][A-Za-z0-9]{1,10})\b/);
    if (after && !ticker && !NOT_A_TICKER.has(after[1].toLowerCase())) ticker = after[1].toUpperCase();
  }
  if (!ticker) {
    const known = rest.match(KNOWN_TICKERS);
    if (known) ticker = known[1].toUpperCase();
  }

  const unsureAmounts = out.questions.filter((q) => q.field === "amount").length;
  if (amounts.length + unsureAmounts > 1 || recipients.length > 1) {
    out.questions.unshift({ field: "split", ask: "That reads like more than one payment. Send them one at a time: one amount, one token, one recipient." });
  }
  if (amounts.length === 1 && !unsureAmounts) out.amount = amounts[0];
  else if (!amounts.length && !unsureAmounts && VAGUE_AMOUNT.test(rest)) {
    out.questions.push({ field: "amount", ask: "How much exactly? I prepare a fixed amount, not \"all\" or \"half\"." });
  }
  if (ticker) out.token = ticker;
  else if (dollars) out.questions.push({ field: "token", ask: "Dollars in which token? If you mean USDC, say USDC; otherwise name the token." });
  if (recipients.length === 1) {
    out.recipient = recipients[0].value;
    out.recipientKind = recipients[0].kind;
  }
  return out;
}

export function parsePayment(text: string, answers: string[] = []): { intent: Intent } | { questions: Question[] } {
  const r = read(text);
  for (const a of answers) {
    // An answer only fills what it actually says; it never reopens a field the sentence already settled.
    const ans = read(a);
    if (ans.amount) {
      r.amount = ans.amount;
      r.questions = r.questions.filter((q) => q.field !== "amount");
    }
    if (ans.token) {
      r.token = ans.token;
      r.questions = r.questions.filter((q) => q.field !== "token");
    }
    if (ans.recipient) {
      r.recipient = ans.recipient;
      r.recipientKind = ans.recipientKind;
      r.questions = r.questions.filter((q) => q.field !== "recipient");
    }
  }
  const has = (f: Question["field"]) => r.questions.some((q) => q.field === f);
  if (!r.amount && !has("amount")) r.questions.push({ field: "amount", ask: "How much should I send?" });
  if (!r.token && !has("token")) r.questions.push({ field: "token", ask: "Which token: PROS, USDC, WPROS, LINK, WETH, or a token contract address?" });
  if (!r.recipient && !has("recipient")) r.questions.push({ field: "recipient", ask: "Who gets it? A full 0x address, an .eth name, or \"me\" to pay yourself." });
  if (r.questions.length) return { questions: r.questions };
  return { intent: { amount: r.amount!, token: r.token!, recipient: r.recipient!, recipientKind: r.recipientKind! } };
}
