// Small parsers used by the gap checks; kept pure so they are unit-tested.

/** Provider names from the "Available RPC Providers" list of docs.pharos.xyz/tooling-and-infrastructure/rpc.md. */
export function rpcProviders(markdown: string): string[] {
  return [...markdown.matchAll(/^\* (.+ RPC)\s*$/gm)].map((m) => m[1]);
}

/** Rows of the README log table: [#, exact query]. The query is the italic text in the third column. */
export function loggedQueries(readme: string): { n: number; query: string }[] {
  return [...readme.matchAll(/^\| (\d) \| [^|]+ \| \*(.+?)\* \|/gm)].map((m) => ({ n: Number(m[1]), query: m[2] }));
}
