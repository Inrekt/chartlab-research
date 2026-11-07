#!/bin/zsh
# Общая обвязка ЛОКАЛЬНОГО боевого контура машины (мак вместо GitHub Actions).
#
# Почему мак: облачные расписания опаздывают на 30–60 минут и молча
# отменяются, когда в concurrency-группу приходит следующий прогон, а с
# раннеров GitHub биржа отдаёт 451 — живые бары там недоступны в принципе.
# У мака прямой доступ к бирже есть, и инкубатор работает по живым данным,
# а не по корпусу суточной давности.
#
# ⚠️ ИНВАРИАНТ: ЖУРНАЛ ПИШЕТ ОДИН ПРОЦЕСС. Облачные расписания отключены
# (ручной запуск остался). Если их вернуть — два независимых поиска начнут
# тратить одни и те же комбинации дважды, и учёт множественности поедет.
#
# ⚠️ Контур гоняется из ОТДЕЛЬНОГО клона (~/.chartlab/machine), а не из
# рабочей копии ~/chartlab-research: правка файла в середине ночи иначе
# попала бы в прогон, а `git reset --hard` при публикации статуса снёс бы
# несохранённую работу.
set -eu

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO="$HOME/.chartlab/machine"
DATA="$HOME/.chartlab/data-repo"
CORPUS="$HOME/.chartlab/corpus"
LOG_DIR="$HOME/.chartlab/logs"
LOCK_DIR="$HOME/.chartlab/locks"

export RESEARCHER_DATA_DIR="$DATA/ledger"
export RESEARCHER_VAULT_DIR="$DATA/vault"
export RESEARCHER_STATUS_DIR="$REPO/status"
export RESEARCHER_HISTORY_DIR="$CORPUS"
# Без COLLECT_DIR readFundingCsv молча вернёт null на каждый символ, атом
# фандинга даст false на каждом баре, и семейство умрёт как «мало сделок» —
# ровно так в облаке погибли 212 испытаний funding_pressure.
export COLLECT_DIR="$DATA/market"

mkdir -p "$LOG_DIR" "$LOCK_DIR" "$CORPUS"

log() { echo "$(date '+%F %T') $*" }

# Замок на весь контур: ночь и часовой тик не должны писать в базу
# одновременно. Осиротевший замок старше `$2` минут снимается — иначе одна
# авария останавливала бы машину навсегда.
take_lock() {
  local lock="$LOCK_DIR/machine.lock" stale="$2"
  if [ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +"$stale" 2>/dev/null)" ]; then
    rmdir "$lock" 2>/dev/null || true
    log "снят осиротевший замок (держал $1)"
  fi
  mkdir "$lock" 2>/dev/null || return 1
  trap "rmdir '$lock' 2>/dev/null" EXIT INT TERM
  return 0
}

# Свежий код перед прогоном. Клон боевой, ручных правок в нём быть не должно.
update_code() {
  cd "$REPO"
  git fetch -q origin main && git reset -q --hard origin/main
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    log "ставлю зависимости"
    npm ci --no-audit --no-fund >> "$LOG_DIR/npm.log" 2>&1
  fi
}

# Журнал: дамп в git — источник истины, локальная база — производная.
# Если дамп СВЕЖЕЕ базы, база устарела и её надо пересобрать: иначе прогон
# посчитает по старому журналу и затрёт дампом чужие испытания. Ровно в эту
# ловушку я уже наступал (база от 09.08 против дампа от 18.08).
sync_journal_in() {
  cd "$DATA"
  git pull --rebase -q || log "pull журнала не удался — работаю на локальной копии"
  local db="$RESEARCHER_DATA_DIR/trials.sqlite"
  local dump="$RESEARCHER_DATA_DIR/trials.sql.gz"
  if [ -f "$dump" ] && [ "$dump" -nt "$db" ]; then
    log "дамп свежее базы — пересобираю базу из дампа"
    rm -f "$db" "$db-shm" "$db-wal"
  fi
  cd "$REPO"
  npx tsx researcher/journal-sync.ts restore
}

# Дамп и коммит журнала делаются ДАЖЕ после падения прогона: испытания уже в
# базе, и терять их из-за упавшего шага нельзя — иначе следующая ночь честно
# прогонит ровно те же спеки заново.
sync_journal_out() {
  local what="$1"
  cd "$REPO"
  npx tsx researcher/journal-sync.ts dump || { log "ДАМП НЕ УДАЛСЯ"; return 1; }
  cd "$DATA"
  git add -A
  if git diff --cached --quiet; then log "журнал без изменений"; return 0; fi
  git commit -q -m "$what $(date -u '+%F %H:%M') UTC"
  for attempt in 1 2 3; do
    if git pull --rebase -q && git push -q; then log "журнал отправлен"; return 0; fi
    log "push журнала не прошёл (попытка $attempt)"
    sleep 10
  done
  log "ЖУРНАЛ НЕ ОТПРАВЛЕН — лежит локально, отправлю следующим прогоном"
  return 1
}

# Статус — сгенерированный снимок, сливать его не с чем: прав последний
# писатель. Клон боевой, поэтому reset --hard здесь безопасен.
publish_status() {
  local what="$1"
  cd "$REPO"
  [ -f status/status.json ] || { log "статус не сформирован"; return 0; }
  local tmp="$LOG_DIR/.status-publish.json"
  cp status/status.json "$tmp"
  for attempt in 1 2 3; do
    git fetch -q origin main || true
    git reset -q --hard origin/main
    cp "$tmp" status/status.json
    git add status/status.json
    if git diff --cached --quiet; then return 0; fi
    git commit -q -m "status: $what $(date -u '+%F %H:%M') UTC"
    if git push -q; then return 0; fi
    sleep 5
  done
  log "статус не опубликован после трёх попыток"
  return 0
}
