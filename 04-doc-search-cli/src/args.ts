// Command line parsing for rtfm. Pure, so it is unit-tested.

export const HELP = `Usage:
  rtfm <question> [--verify | --no-verify] [--full] [--sources N] [--json]
  rtfm                                ask one question at an "Ask:" prompt (no quoting needed)
  rtfm --verify-on | --verify-off     check answers on-chain by default, or stop (saved)
  rtfm --verify-status                show that setting
  rtfm search <words>                 list matching doc pages
  rtfm page <docs.pharos.xyz URL>     print a whole page

  --verify     check addresses, chain IDs and block limits from the answer on Pharos mainnet (Pharos Chain MCP)
  --no-verify  skip the check for this question even if --verify-on is set
  --full       print the whole answer instead of the first few paragraphs
  --sources N  how many source links to show (default 3)
  --json       machine-readable output

Quotes are optional, but the shell still reads the line first: a question with an apostrophe (what's)
or with ! & | ; < > needs quotes, or just run rtfm and type it at the prompt.

Exit codes: 0 answered, 2 the docs have no answer, 1 error.`;

export interface AskOptions {
  question: string;
  /** undefined = use the saved setting */
  verify?: boolean;
  full: boolean;
  sources: number;
  json: boolean;
}

export type Command =
  | { kind: "help"; code: number }
  | { kind: "prompt"; options: AskOptions; setVerify?: boolean }
  | { kind: "settings"; setVerify?: boolean }
  | { kind: "search"; words: string }
  | { kind: "page"; url: string }
  | { kind: "ask"; options: AskOptions; setVerify?: boolean };

export function parseArgs(args: string[]): Command {
  if (args[0] === "-h" || args[0] === "--help") return { kind: "help", code: 0 };
  if (args[0] === "search") {
    const words = args.slice(1).join(" ").trim();
    if (!words) throw new Error("Usage: rtfm search <words>");
    return { kind: "search", words };
  }
  if (args[0] === "page") {
    if (!args[1] || !/^https:\/\/docs\.pharos\.xyz\//.test(args[1])) throw new Error("Usage: rtfm page https://docs.pharos.xyz/...");
    return { kind: "page", url: args[1] };
  }

  const options: AskOptions = { question: "", full: false, sources: 3, json: false };
  let setVerify: boolean | undefined;
  let status = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const flag = a.toLowerCase(); // --verifyON works as well as --verify-on
    if (flag === "--verify-on" || flag === "--verifyon") setVerify = true;
    else if (flag === "--verify-off" || flag === "--verifyoff") setVerify = false;
    else if (flag === "--verify-status") status = true;
    else if (flag === "--verify") options.verify = true;
    else if (flag === "--no-verify") options.verify = false;
    else if (flag === "--full") options.full = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--sources") options.sources = Math.max(1, Number(args[++i]) || 3);
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}\n\n${HELP}`);
    else words.push(a);
  }
  options.question = words.join(" ").trim();

  if (options.question) return { kind: "ask", options, setVerify };
  if (setVerify !== undefined || status) return { kind: "settings", setVerify };
  return { kind: "prompt", options };
}
