import { test } from "node:test";
import assert from "node:assert/strict";
import { hitsFromSearch, quotesFrom, readTheDocs } from "./docs.js";
import { ScriptedLine } from "./fakes.js";

const SEARCH = `Title: Circle CCTP
Link: https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp
Content: Blockchain
Domain
Title: Gas Model
Link: https://docs.pharos.xyz/getting-started/gas-model
Content: gas`;

test("search hits come out in the server's order with their titles", () => {
  assert.deepEqual(hitsFromSearch(SEARCH), [
    { title: "Circle CCTP", url: "https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp" },
    { title: "Gas Model", url: "https://docs.pharos.xyz/getting-started/gas-model" },
  ]);
});

test("quotes are whole lines from the page, addresses match in any case", () => {
  const page = { url: "u", title: "t", text: "intro\n| **Pharos** | 31 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |\nsendMessage is how you send\n" };
  const quotes = quotesFrom(page, ["0x81d40f21f12a8f0e3252bccb954d722d4c464b64", "sendMessage"]);
  assert.equal(quotes.length, 2);
  for (const q of quotes) assert.ok(page.text.includes(q.text));
  // Function names are case-sensitive: "sendmessage" is not the function the user asked about.
  assert.equal(quotesFrom(page, ["sendmessage"]).length, 0);
});

test("pages that never mention the subject are skipped, the docs MCP is the only source", async () => {
  const docs = new ScriptedLine("docs", {
    searchDocumentation: SEARCH,
    getPage: (args) =>
      String(args.url).includes("cctp") ? "# Circle CCTP\ncall MessageTransmitterV2#sendMessage to send" : "# Gas Model\nnothing relevant",
  });
  const brief = await readTheDocs(docs, { key: "k", subject: "s", searches: ["sendMessage"], needles: ["sendMessage"] });
  assert.deepEqual(brief.pages.map((p) => p.title), ["Circle CCTP"]);
  assert.equal(brief.quotes[0]?.text, "call MessageTransmitterV2#sendMessage to send");
  assert.deepEqual(docs.asked.map((a) => a.tool), ["searchDocumentation", "getPage", "getPage"]);
});
