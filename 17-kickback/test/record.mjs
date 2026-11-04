// Records real Chain MCP answers into test/tapes/buyers.json so the buyers test can replay mainnet offline.
// Read-only tools only. Run after `npm run build`: node test/record.mjs
import { writeFileSync } from "node:fs";
import { chainOver, recordingAsk } from "../dist/chain.js";
import { collectPool, findPairs } from "../dist/buyers.js";
import { PharosMcp } from "../dist/mcp.js";

const ME = "0x46441dc99f8000959e9c48cf2a01a018d131d3bb";
const mcp = new PharosMcp("kickback-recorder");
await mcp.connect();
const tape = {};
const chain = chainOver(recordingAsk((tool, args) => mcp.call(tool, args), tape));
const snapshot = await chain.blockNumber();
const pairs = await findPairs(chain, snapshot);
const pool = await collectPool(chain, pairs, { snapshot, size: 30, lookback: 50000, exclude: [ME] });
await mcp.close();
writeFileSync("test/tapes/buyers.json", `${JSON.stringify({ snapshot: snapshot.toString(), recordedAt: new Date().toISOString(), tape }, null, 1)}\n`);
console.log(`snapshot ${snapshot}, ${pairs.length} pairs, ${pool.people.length} people back to block ${pool.scannedFrom}, ${chain.journal.length} MCP calls`);
