#!/usr/bin/env bash
# Запуск містка локального рантайму від користувача, який увійшов у Claude Code (на цьому сервері — deploy).
# Місток слухає лише внутрішню адресу Docker: його бачать контейнери, але не інтернет. Стартує ВИМКНЕНИМ.
set -euo pipefail
HOME_DIR="${UFV_BRIDGE_HOME:-$HOME/ufv-runtime-bridge}"
mkdir -p "$HOME_DIR" && chmod 700 "$HOME_DIR"
install -m 600 "$(dirname -- "${BASH_SOURCE[0]}")/bridge.mjs" "$HOME_DIR/bridge.mjs"
[ -s "$HOME_DIR/token" ] || (umask 077; head -c 36 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 40 > "$HOME_DIR/token")
for pid in $(pgrep -u "$(id -u)" -x node || true); do tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "$HOME_DIR/bridge[.]mjs" && kill "$pid" || true; done
sleep 1
UFV_BRIDGE_TOKEN="$(cat "$HOME_DIR/token")" UFV_BRIDGE_BIND="${UFV_BRIDGE_BIND:-172.17.0.1}" UFV_BRIDGE_PORT="${UFV_BRIDGE_PORT:-8790}" \
  UFV_BRIDGE_STATE="$HOME_DIR/state.json" setsid nohup node "$HOME_DIR/bridge.mjs" >> "$HOME_DIR/bridge.log" 2>&1 < /dev/null &
sleep 2; tail -1 "$HOME_DIR/bridge.log"
echo "token file: $HOME_DIR/token (скопіюйте значення в /etc/ufv/production.env; у Git і чати не вставляти)"
