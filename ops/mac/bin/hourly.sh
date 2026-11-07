#!/bin/zsh
# Часовой тик: догонка инкубатора и надзора по ЖИВЫМ барам биржи.
# Здесь у мака реальное преимущество над облаком: раннерам GitHub биржа
# отвечает 451, и тик там вынужденно считал по корпусу суточной давности.
set -eu
source "$HOME/.chartlab/bin/env.sh"

LOG="$LOG_DIR/hourly.log"
exec >> "$LOG" 2>&1

if ! take_lock "тик" 60; then
  log "идёт другой прогон — тик пропущен"
  exit 0
fi

update_code
sync_journal_in

set +e
npx tsx "$REPO/researcher/hourly.ts"
TICK_STATUS=$?
set -e

sync_journal_out "tick" || true
publish_status "tick" || true
[ "$TICK_STATUS" -eq 0 ] || log "тик завершился с кодом $TICK_STATUS"
