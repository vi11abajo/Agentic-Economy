// The shapes the Telegram channel speaks. What to send and to whom lives in rules.ts and notifier.ts now; this file
// keeps the two-wave launch message types the channel still offers (a QR photo, then a reply under it).
import type { walletLinks } from "./links.js";

export interface Wave1Extras {
  url: string;
  links: ReturnType<typeof walletLinks>;
}
export interface PushChannel {
  sendWave1: (chatId: number, text: string, extras?: Wave1Extras) => Promise<number>;
  sendWave2: (chatId: number, replyTo: number, text: string) => Promise<void>;
}
