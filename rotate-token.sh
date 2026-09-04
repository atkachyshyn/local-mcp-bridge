#!/bin/sh
# Rotate the Local MCP Bridge loopback bearer token.
#
# Use this when the token may have been disclosed -- for example if
# extension/config.js was ever committed. Rotation is what invalidates a
# disclosed credential; deleting the file from Git history is not.
#
# Rewrites both halves of the pair atomically-ish and leaves a backup of the
# previous token so a failed daemon restart is recoverable.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STATE="$HOME/.local-mcp-bridge"
PORT="${LOCAL_MCP_BRIDGE_PORT:-8765}"

mkdir -p "$STATE"
chmod 700 "$STATE"

if [ -s "$STATE/token" ]; then
  cp "$STATE/token" "$STATE/token.previous"
  chmod 600 "$STATE/token.previous"
  printf 'Previous token backed up to %s/token.previous\n' "$STATE"
fi

TOKEN=$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)

umask 077
printf '%s\n' "$TOKEN" > "$STATE/token"
chmod 600 "$STATE/token"

cat > "$ROOT/extension/config.js" <<EOF2
globalThis.LOCAL_MCP_BRIDGE_CONFIG = Object.freeze({
  endpoint: "http://127.0.0.1:${PORT}",
  token: "${TOKEN}"
});
EOF2
chmod 600 "$ROOT/extension/config.js"

printf '\nRotated local bridge token.\n'
printf '  daemon token : %s/token\n' "$STATE"
printf '  extension    : %s/extension/config.js (git-ignored)\n' "$ROOT"
printf '\nNext:\n'
printf '  1. restart the daemon      ./start.sh\n'
printf '  2. reload the extension    chrome://extensions -> Reload\n'
printf '  3. once it works, remove   %s/token.previous\n' "$STATE"
