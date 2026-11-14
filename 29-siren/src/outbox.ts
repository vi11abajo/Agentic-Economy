// Sends what's waiting. An alert leaves the outbox only when every channel took it; a channel that already took it
// isn't asked again, so a Discord hiccup never means a second Telegram message.
import { consoleLine } from "./alert.js";
import { DeliveryError, type Channel } from "./deliver.js";
import type { State } from "./state.js";

// a channel that keeps failing for this many rounds gets its copy dropped, with a line saying so
const GIVE_UP = 30;

export interface Flushed {
  sent: number;
  waiting: number;
  problems: string[];
}

export async function flush(state: State, chans: Channel[], print: (line: string) => void): Promise<Flushed> {
  const problems: string[] = [];
  let sent = 0;
  const left: State["outbox"] = [];
  for (const p of state.outbox) {
    if (p.tries === 0) print(consoleLine(p.alert));
    p.tries++;
    let broken = false;
    for (const c of chans) {
      if (p.delivered.includes(c.name)) continue;
      try {
        await c.send(p.alert);
        p.delivered.push(c.name);
      } catch (e) {
        const d = e instanceof DeliveryError ? e : new DeliveryError(String((e as Error).message), "kept for the next round", true);
        problems.push(`${c.name}: ${d.message} (${d.hint})`);
        if (!d.retry || p.tries >= GIVE_UP) {
          p.delivered.push(c.name);
          problems.push(`${c.name}: gave up on "${p.alert.title}" ${p.alert.id}`);
        } else broken = true;
      }
    }
    if (broken) left.push(p);
    else sent++;
  }
  state.outbox = left;
  return { sent, waiting: left.length, problems: [...new Set(problems)] };
}
