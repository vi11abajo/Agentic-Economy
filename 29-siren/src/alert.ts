// One alert, and how it reads in each place it goes. Every alert says what happened, how much, and links to the
// explorer so you can check it yourself.
export interface Alert {
  id: string;
  rule: string;
  kind: "transfer" | "price" | "call";
  title: string;
  value: string;
  facts: Array<[string, string]>; // label, text (plain)
  links: Array<[string, string]>; // label, url
  block?: string;
  at: string; // ISO time of the block or the feed update
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function telegramText(a: Alert): string {
  return [
    `<b>${esc(a.title)}</b>`,
    `<b>${esc(a.value)}</b>`,
    ...a.facts.map(([k, v]) => `${esc(k)}: <code>${esc(v)}</code>`),
    a.links.map(([k, u]) => `<a href="${esc(u)}">${esc(k)}</a>`).join(" · "),
    `<i>${esc(a.rule)} · ${esc(a.at)}${a.block ? ` · block ${a.block}` : ""}</i>`,
  ].join("\n");
}

const COLOR = { transfer: 0x2e7d32, price: 0xef6c00, call: 0x5865f2 } as const;

export function discordBody(a: Alert): object {
  return {
    username: "siren",
    embeds: [
      {
        title: a.title.slice(0, 256),
        url: a.links[0]?.[1],
        description: `**${a.value}**\n${a.links.map(([k, u]) => `[${k}](${u})`).join(" · ")}`,
        color: COLOR[a.kind],
        fields: a.facts.slice(0, 20).map(([name, value]) => ({ name, value: `\`${value}\``.slice(0, 1024), inline: value.length < 30 })),
        footer: { text: `${a.rule}${a.block ? ` · block ${a.block}` : ""}` },
        timestamp: a.at,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function consoleLine(a: Alert, now = new Date()): string {
  const facts = a.facts.map(([k, v]) => `${k} ${v}`).join(", ");
  return `[${now.toISOString()}] ${a.title}: ${a.value}${facts ? ` (${facts})` : ""} ${a.links[0]?.[1] ?? ""}`;
}
