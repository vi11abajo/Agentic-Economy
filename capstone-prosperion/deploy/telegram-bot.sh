#!/usr/bin/env bash
# Gives your copy of Prosperion its own Telegram bot, so launch alerts have somewhere to go.
# Make the bot first: talk to @BotFather, send /newbot, copy the token it gives you. Then, from capstone-prosperion/:
#   ssh -t <your-host> 'sudo bash -s' < deploy/telegram-bot.sh
# The token is typed, not passed as an argument, so it stays out of shell history and the process list.
set -euo pipefail
ENV_FILE=/opt/prosperion/.env
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE is missing: run deploy/push.sh once first."; exit 1; }

printf "Paste the bot token from @BotFather (it is not shown): "
read -rs token </dev/tty
echo
[[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || { echo "That does not look like a bot token (digits, a colon, then letters)."; exit 1; }

# Ask Telegram who this is before saving anything; a typo should not cost a restart.
me=$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$token" | curl -fsS -K -) \
  || { echo "Telegram did not accept that token. Nothing was changed."; exit 1; }
name=$(printf '%s' "$me" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')

if grep -q '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE"; then
  sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${token}|" "$ENV_FILE"
else
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token" >> "$ENV_FILE"
fi
unset token
systemctl restart prosperion.service
echo "Saved. @${name} is now this copy's bot; the Alerts section of your page offers 'Link Telegram'."
