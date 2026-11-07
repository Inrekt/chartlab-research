#!/bin/zsh
# Ночь машины на маке.
#
# Расписание (с 2026-11-07): launchd будит скрипт КАЖДЫЙ ЧАС
# (StartInterval=3600), а ночь стартует при первом за сутки пробуждении на
# питании. Раньше ночь была прибита к 02:37 и на батарее просто пропускалась —
# ноутбук в это время почти всегда без зарядки, и с 2026-08-20 так пропало
# 66 ночей. Теперь пропуск на батарее — не потеря суток, а ожидание розетки.
#
# Источник истины этого файла — репозиторий chartlab-research (ops/mac);
# в ~/.chartlab/bin он попадает через ops/mac/install.sh.
#
# Отметки в $STATE_DIR читает сторож молчания часового тика: по ним он
# отличает «на батарее» от «упала» и «оборвалась».
set -eu
source "$HOME/.chartlab/bin/env.sh"

LOG="$LOG_DIR/nightly.log"
exec >> "$LOG" 2>&1

STATE_DIR="$HOME/.chartlab/state"
mkdir -p "$STATE_DIR"
TODAY="$(date '+%F')"
NOW_EPOCH="$(date '+%s')"
NOW_ISO="$(date -u '+%FT%TZ')"
# Две ночи подряд через полночь (23:50 и 00:10) — не «раз в сутки».
MIN_GAP_SEC=$((12 * 3600))

# Сегодня ночь уже была — молча выходим: launchd зовёт нас каждый час, и
# строка в логе на каждый вызов утопила бы настоящие события.
if [ -f "$STATE_DIR/night-started" ]; then
  read -r LAST_DAY LAST_EPOCH _ < "$STATE_DIR/night-started" || true
  if [ "${LAST_DAY:-}" = "$TODAY" ] || [ $((NOW_EPOCH - ${LAST_EPOCH:-0})) -lt $MIN_GAP_SEC ]; then
    exit 0
  fi
fi

# Тяжёлый прогон только на питании: на батарее ноутбук уйдёт спать в середине
# и оставит замок с недописанной ночью. Часовой тик при этом продолжает
# работать — он дешёвый. В лог — один раз за день, отметка — каждый раз.
if ! pmset -g batt | head -1 | grep -q "AC Power"; then
  LAST_SKIP_DAY=""
  [ -f "$STATE_DIR/night-battery-skip" ] && read -r LAST_SKIP_DAY _ < "$STATE_DIR/night-battery-skip" || true
  [ "$LAST_SKIP_DAY" = "$TODAY" ] || log "на батарее — ночь ждёт питания (проверяю каждый час)"
  echo "$TODAY $NOW_ISO" > "$STATE_DIR/night-battery-skip"
  exit 0
fi

# Тик и ночь оба просыпаются раз в час и могут сталкиваться на замке каждый
# раз. Тик держит замок минуты, поэтому ночь ждёт до 15 минут, а не
# откладывается — иначе она могла бы проигрывать гонку бесконечно.
LOCK_WAIT_TRIES=30
until take_lock "ночь" 360; do
  LOCK_WAIT_TRIES=$((LOCK_WAIT_TRIES - 1))
  if [ $LOCK_WAIT_TRIES -le 0 ]; then
    log "замок занят 15 минут — ночь попробую через час"
    exit 0
  fi
  sleep 30
done

# Отметка «сегодня уже было» ставится при СТАРТЕ: упавшая ночь не должна
# перезапускаться каждый час и жечь комбинации повторными наборами партий.
echo "$TODAY $NOW_EPOCH $NOW_ISO" > "$STATE_DIR/night-started"

log "=== ночь начинается ==="
update_code
sync_journal_in

# Корпус — воспроизводимый артефакт, лежит ВНЕ git (181 МБ; коммитить его
# каждую ночь значило бы растить репозиторий на сотню мегабайт за раз).
# Первый запуск засевает его из репозитория, дальше дописывается только хвост.
if [ ! -f "$CORPUS/manifest.json" ]; then
  # Корпуса перпов в git НЕТ (в облаке он жил в кэше раннера). Засеваем из
  # рабочей копии, если она есть; иначе холодная сборка с зеркала ~20 минут.
  # Без манифеста тик берёт живые бары со СПОТА — кандидат, отобранный на
  # перпах, догонялся бы на другом рынке.
  if [ -d "$HOME/chartlab-research/public/data/history-perp" ]; then
    log "корпус пуст — засеваю из рабочей копии"
    rsync -a "$HOME/chartlab-research/public/data/history-perp/" "$CORPUS/"
  else
    log "корпуса нет ни здесь, ни в рабочей копии — соберу с зеркала целиком"
  fi
fi

# Источник `mirror` оставлен намеренно, хотя у мака есть прямой REST: это
# ТЕ ЖЕ фьючерсные свечи, и менять источник посреди эпохи — значит без нужды
# завести вопрос «сравнимы ли испытания до и после». Отставание хвоста на
# сутки для ночного скрина по пятилетней истории несущественно, а инкубатор
# и так ходит на биржу живьём.
log "дописываю хвост корпуса"
npx tsx "$REPO/researcher/collect-candles.ts" --source mirror --tf 1h,4h --out "$CORPUS" || \
  log "корпус не обновился — предполёт решит, можно ли считать"

log "запускаю перебор"
export RESEARCHER_NIGHT_N="${RESEARCHER_NIGHT_N:-2000}"
set +e
caffeinate -i npx tsx "$REPO/researcher/nightly.ts" > "$LOG_DIR/night-summary.json"
NIGHT_STATUS=$?
set -e
log "перебор завершён с кодом $NIGHT_STATUS"

echo "$(date -u '+%FT%TZ') $NIGHT_STATUS" > "$STATE_DIR/night-ended"

sync_journal_out "night" || true
publish_status "night" || true
log "=== ночь закончена (код $NIGHT_STATUS) ==="
