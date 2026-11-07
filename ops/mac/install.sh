#!/bin/zsh
# Ставит боевой контур мака из репозитория: скрипты в ~/.chartlab/bin и
# расписания launchd. Это ПОСТОЯННАЯ настройка системы — запускать руками,
# с согласия владельца. Повторный запуск безопасен.
#
#   zsh ops/mac/install.sh            # показать, что изменится
#   zsh ops/mac/install.sh --apply    # поставить и перезагрузить launchd
set -eu
HERE="${0:A:h}"
BIN="$HOME/.chartlab/bin"
AGENTS="$HOME/Library/LaunchAgents"
APPLY="${1:-}"

for f in env.sh hourly.sh nightly.sh; do
  diff -q "$HERE/bin/$f" "$BIN/$f" >/dev/null 2>&1 && echo "без изменений: $f" || echo "ИЗМЕНИТСЯ: $BIN/$f"
done
for f in "$HERE"/launchd/*.plist; do
  n="${f:t}"
  diff -q "$f" "$AGENTS/$n" >/dev/null 2>&1 && echo "без изменений: $n" || echo "ИЗМЕНИТСЯ: $AGENTS/$n"
done
[ "$APPLY" = "--apply" ] || { echo "(сухой прогон; для установки: --apply)"; exit 0; }

mkdir -p "$BIN" "$AGENTS"
cp "$HERE"/bin/*.sh "$BIN/" && chmod +x "$BIN"/*.sh
for f in "$HERE"/launchd/*.plist; do
  n="${f:t}"; label="${n%.plist}"
  diff -q "$f" "$AGENTS/$n" >/dev/null 2>&1 && continue
  cp "$f" "$AGENTS/$n"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$n"
  echo "перезагружен: $label"
done
launchctl list | grep chartlab || true
