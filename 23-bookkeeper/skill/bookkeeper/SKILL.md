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

1. `bookkeeper init` makes the data folder, a fresh wallet key in its `.env` and the launcher the OS scheduler
   starts. It prints the paying wallet address. Never open, print or ask for the `.env` contents: the key is the
   user's money. If the user wants to use a wallet they already have, `bookkeeper init --no-key` leaves the key
   line empty and they paste it in themselves.
2. Tell the user to send USDC (or PROS) for the payouts plus a little PROS for gas to that address.
3. For reports, the user fills `BOOKKEEPER_TELEGRAM_BOT_TOKEN` (from @BotFather) and/or `BOOKKEEPER_DISCORD_WEBHOOK`
   in the `.env` themselves, sends `/start` to their bot, and you run `bookkeeper notify-test` (it finds the chat id).

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
