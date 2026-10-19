// Turns the Docs MCP's markdown reply into something short for a terminal, and tells a real answer from
// "the docs don't cover this". Pure functions, unit-tested on recorded replies.

export interface Source {
  title: string;
  url: string;
}

export interface Answer {
  body: string; // markdown, without the sources list
  sources: Source[];
}

/** askQuestion replies end with "# Sources" and a markdown list of links. */
export function parseAnswer(raw: string): Answer {
  const at = raw.search(/^#+\s*Sources\s*$/m);
  const body = (at < 0 ? raw : raw.slice(0, at)).trim();
  const sources = at < 0 ? [] : links(raw.slice(at));
  return { body, sources: dedupe(sources) };
}

/** searchDocumentation replies are blocks of "Title: …\nLink: …\nContent: …". */
export function parseSearch(raw: string): Source[] {
  return dedupe([...raw.matchAll(/^Title: (.+)\nLink: (\S+)/gm)].map((m) => ({ title: m[1].trim(), url: m[2] })));
}

// The docs agent says it plainly when the docs don't have it. Only the opening sentence counts, so an answer
// like "It has to be a Skill. Anvita Flow does not provide …" is not mistaken for a miss.
const NO_ANSWER = [
  /\bI (?:cannot|can't|could not|couldn't|was unable to) (?:find|confirm)\b/i,
  /\b(?:there is|there's) no documented\b/i,
  /\b(?:the )?(?:pharos )?(?:documentation|docs) (?:does not|doesn't|do not|don't) (?:publish|document|cover|mention|include|contain|describe|say|provide|list)\b/i,
  /\bis not (?:explicitly )?(?:documented|covered|mentioned)\b/i,
  /\bno (?:information|mention|documentation)\b/i,
  /\bnot (?:in|covered by|part of) the (?:pharos )?(?:docs|documentation)\b/i,
];

export function isNoAnswer(body: string): boolean {
  const opening = firstSentence(plain(body)).replace(/[‘’]/g, "'");
  return opening.length === 0 || NO_ANSWER.some((re) => re.test(opening));
}

export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = flat.match(/^.+?[.!?](?=\s|$)/);
  return (m ? m[0] : flat).trim();
}

/** Markdown to plain terminal text: no bold/italics markers, no link syntax, tables as "a · b". */
export function plain(md: string): string {
  return md
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1$2")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/^\|?\s*[-:| ]+\|\s*$/gm, "")
    .replace(/^\|(.+)\|\s*$/gm, (_, row: string) => row.split("|").map((c) => c.trim()).join(" · "))
    .replace(/^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Keeps the start of a long answer: whole paragraphs up to `maxLines` lines. */
export function concise(text: string, maxLines = 14): { text: string; trimmed: boolean } {
  const paragraphs = text.split(/\n\s*\n/);
  const kept: string[] = [];
  let lines = 0;
  for (const p of paragraphs) {
    const n = p.split("\n").length;
    if (kept.length > 0 && lines + n > maxLines) break;
    kept.push(p);
    lines += n;
  }
  return { text: kept.join("\n\n"), trimmed: kept.length < paragraphs.length };
}

function links(md: string): Source[] {
  return [...md.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => ({ title: m[1].trim(), url: m[2] }));
}

function dedupe(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}
