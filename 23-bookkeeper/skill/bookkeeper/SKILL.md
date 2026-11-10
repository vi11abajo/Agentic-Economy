---
name: bookkeeper
description: >
  bookkeeper: sets up and runs recurring payments on Pharos mainnet - payroll, rent, subscriptions - from its own
  wallet. The user says it in plain words ("pay my team every Friday and the subscription once a month starting
  today"); the agent asks for whatever is missing (who, how much, which token, how often, and always when the first
  payment goes out), shows one plan and waits for an explicit yes. After that the OS scheduler wakes the bookkeeper
  on its own and it pays every period until the wallet runs out or the user stops the series. USDC is paid by
  transferWithAuthorization with a nonce per series, period and payee, so the USDC contract itself refuses a second
  payment of the same period. Every payout goes to the user's Telegram bot and Discord (who, how much, when, tx
  link); after each payout it checks how many more periods the wallet covers and warns when the next one isn't.
  Short balance, failed sends and missed periods are written to a journal the agent can read back and explain.
  Use when someone wants to pay someone regularly on Pharos, check what was paid, or stop a recurring payment.
version: 1.0.0
requires:
  anyBins:
  - node
---

# bookkeeper

`node scripts/bookkeeper.mjs <command>` (below just `bookkeeper`). Data folder: `%APPDATA%\bookkeeper` on Windows,
`~/.config/bookkeeper` elsewhere (`--home <dir>` to change).

## First time

1. `bookkeeper init` makes the data folder, the launcher the OS scheduler starts, and a `.env` with empty lines.
   It prints the full path of the `.env` and which lines are empty.
2. Give the user that path and ask them to open it in a text editor, fill these lines after `=` and save:
   - `BOOKKEEPER_PRIVATE_KEY=` the private key of the wallet the bookkeeper pays from (best a separate wallet that
     holds only what the payouts need, plus a little PROS for gas);
   - `BOOKKEEPER_DISCORD_WEBHOOK=` and/or `BOOKKEEPER_TELEGRAM_BOT_TOKEN=` where the reports go (at least one).
   Keep it to that short request. Give the step-by-step guide below only if the user asks how to get a key, a
   bot token or a webhook. If they'd rather have a brand-new wallet, `bookkeeper init --new-key` makes one and
   prints only its address.
3. Never ask the user to paste a key, token or webhook into the chat, and never read, print or `cat` the `.env`.
   `bookkeeper settings` tells which lines are filled without showing them.
4. When they say it's saved: `bookkeeper settings`, then `bookkeeper notify-test` (for Telegram it finds the chat id
   once the user has sent `/start` to their bot), then `bookkeeper wallet` to show the address and balances.

### Guide, only when the user asks

- **Telegram bot:** in Telegram open @BotFather and send `/newbot`; send a name for the bot; send a username of
  5-32 Latin letters, digits or `_` ending in `bot`; BotFather answers with a token like `110201543:AAHdqTcv...`,
  that goes after `BOOKKEEPER_TELEGRAM_BOT_TOKEN=`; open the new bot (the t.me link BotFather gives) and press
  Start or send `/start`. The chat id line stays empty: notify-test fills it.
- **Discord webhook:** in the server's Server Settings open Integrations; create a webhook (Create Webhook / New
  Webhook), pick the text channel it posts to; press Copy Webhook URL and paste it after
  `BOOKKEEPER_DISCORD_WEBHOOK=`. No Integrations there means no right to manage webhooks on that server (their own
  server works).
- **Private key:** most wallets export it from the account's settings ("Show/Export private key"). Suggest a fresh
  account made only for payouts rather than their main one.

## Setting up payments

1. Understand the request and write what you understood to a JSON file:
   `{"label":"Team payroll","token":"USDC","payees":[{"name":"Pete","address":"0x...","amount":"50"}],
   "every":{"n":1,"unit":"week"},"first":"2026-11-13T09:00","tz":"Europe/Moscow"}`.
   `unit` is minute|hour|day|week|month; `first` is the user's wall clock time in `tz`. Leave out anything the user
   did not say; never guess an amount, an address, a token, a period or the first payment time. Names the user
   paid before are filled from the address book. "Starting today" still needs a time: ask it.
   Several series (payroll + subscription) = one draft per series.
2. `bookkeeper draft plan.json`. Exit code 2 and `STILL NEED` lines: ask the user those questions, one at a time,
   in the user's language, update the JSON, draft again.
   For payments more often than hourly the draft asks how often to check: propose an interval (the draft suggests
   one), agree it with the user, put it in `checkEveryMinutes`.
3. When draft prints `PLAN <id>`, retell the whole plan to the user: who gets how much of which token, how often,
   the first payment time and the next ones, how often the bookkeeper checks, that it runs until the wallet is
   empty or they stop it. Ask for an explicit yes.
4. Only after a clear yes to that exact plan: `bookkeeper approve <id>`. It switches the series on, writes the OS
   scheduler entries and pays at once if the first payment is already due. If the scheduler could not be written,
   ask the user to run `bookkeeper schedule install` themselves.

Wake rule (the user's): monthly series are checked weekly, weekly ones daily, daily and hourly ones hourly, faster
ones at the agreed interval; plus one wake exactly at the next payment time, re-armed by every run.

## What happens on its own

Every wake runs `bookkeeper run`: pays what is due, finishes payments an earlier run left half done, writes
everything to `journal.jsonl`, sends Telegram/Discord cards, re-arms the next wake.
- Not enough money: nothing is sent, one "waiting" message; it pays on the first wake after a top-up, once.
- A period that ended unpaid is `missed`: told once, never paid late on its own. Pay it later only if the user
  asks, as a new one-off plan.
- A failed send is retried on the next wake. USDC cannot be paid twice for one period (the token checks the
  nonce); PROS is guarded by the journal (the signed bytes are written before sending and re-sent, never rebuilt).

## Answering questions

- "What's been paid?", "When is the next payment?": `bookkeeper status` (history, counts, next payment, how many
  more periods the wallet covers).
- "Why wasn't Pete paid on the 12th?": `bookkeeper log --series <id> --json` and explain the events for that
  period in plain words: `due` (the period came), `short` (need/have), `signed`/`sent` (tx), `paid` (block),
  `failed` (reason; retried next wake), `missed` (the period ended first), `notified` (the message went out).
  Quote tx hashes with the explorer link https://www.pharosscan.xyz/tx/<hash>.
- "Stop the subscription": `bookkeeper stop <id>` (confirm which series first); `resume <id>` turns it back on.
- `bookkeeper wallet`: balances and how long they last.
