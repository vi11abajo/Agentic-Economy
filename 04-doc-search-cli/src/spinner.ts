// One status line while rtfm waits: a random phrase and the seconds so far. Goes to stderr, so stdout
// (answers, --json) stays clean, and only when stderr is a real terminal.

export const ASKING = [
  "Dusting off the manuals",
  "Staring at the horizon",
  "Polishing the lighthouse lens",
  "Reading the fine print so you don't have to",
  "Waking up the lighthouse keeper",
  "Flipping through chapter 7",
  "Squinting at the small print",
  "Asking the librarian very politely",
  "Untangling the footnotes",
  "Checking the tide tables",
];
export const VERIFYING = ["Checking the rocks on-chain", "Asking the chain if the docs are lying"];

export interface Spinner {
  phase(phrases: string[]): void;
  stop(): void;
}

export function startSpinner(
  phrases: string[],
  out: NodeJS.WriteStream = process.stderr,
  enabled = Boolean(out.isTTY) || process.env.RTFM_PROGRESS === "1",
  random: () => number = Math.random,
): Spinner {
  if (!enabled) return { phase() {}, stop() {} };
  const started = Date.now();
  let list = phrases;
  let phrase = pick(list, random);
  let lastSwitch = started;
  const draw = () => {
    const now = Date.now();
    if (now - lastSwitch >= 6000) {
      phrase = pick(list, random, phrase);
      lastSwitch = now;
    }
    out.write(`\r\x1b[2K\x1b[38;2;107;107;107m${phrase}… ${Math.floor((now - started) / 1000)}s\x1b[0m`);
  };
  draw();
  const timer = setInterval(draw, 1000);
  return {
    phase(next) {
      list = next;
      phrase = pick(list, random);
      lastSwitch = Date.now();
      draw();
    },
    stop() {
      clearInterval(timer);
      out.write("\r\x1b[2K");
    },
  };
}

/** A random phrase, not the same one twice in a row. */
export function pick(list: string[], random: () => number = Math.random, not?: string): string {
  const pool = list.length > 1 && not ? list.filter((p) => p !== not) : list;
  return pool[Math.floor(random() * pool.length) % pool.length];
}
