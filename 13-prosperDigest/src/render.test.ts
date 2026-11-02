import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discordPayload, htmlReport, markdownReport, reportName, telegramText } from "./render.js";
import { sampleDigest } from "./testkit.js";

describe("render", () => {
  const d = sampleDigest();

  it("telegram text has the label, metrics with change, events and escaped symbols", () => {
    const t = telegramText(d);
    assert.ok(t.includes("2026-W44"));
    assert.ok(t.includes("Volume"));
    assert.ok(t.includes("▲ 23%"), t);
    assert.ok(t.includes("$MOON graduated to FaroSwap"));
    assert.ok(t.includes("K&lt;T&gt;") && !t.includes("K<T>"));
    assert.ok(t.includes('href="https://www.pharosscan.xyz/tx/0x'));
    assert.ok(t.length < 4000);
  });

  it("a first digest shows n/a, never NaN", () => {
    const t = telegramText(sampleDigest({ prev: undefined }));
    assert.ok(t.includes("n/a") && !t.includes("NaN"));
    assert.ok(!JSON.stringify(discordPayload(sampleDigest({ prev: undefined }))).includes("NaN"));
  });

  it("discord payload is two embeds within Discord limits", () => {
    const p = discordPayload(d) as { username: string; embeds: Array<{ fields?: unknown[]; description?: string }> };
    assert.equal(p.username, "Prosper Weekly");
    assert.equal(p.embeds.length, 2);
    assert.equal(p.embeds[0].fields!.length, 6);
    assert.ok(JSON.stringify(p).length < 6000);
    assert.ok(p.embeds[1].description!.includes("Top tokens: $K<T> 9,820 · $TOK1 9,520 · $TOK2 9,220"), p.embeds[1].description);
  });

  it("html report is standalone and explains the event rules", () => {
    const h = htmlReport(d);
    assert.ok(!/<(script|link|img)[^>]+(src|href)="http/i.test(h));
    assert.ok(h.includes("How events were picked"));
    assert.ok(h.includes("TOK19"));
    assert.ok(markdownReport(d).includes("| Volume |"));
    assert.equal(reportName(d), "prosper-digest-2026-10-26_7d");
  });
});
