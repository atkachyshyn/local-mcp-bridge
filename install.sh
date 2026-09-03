#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STATE="$HOME/.local-mcp-bridge"
OLD_POC_STATE="$HOME/.local-mcp-bridge-poc"
OLD_ATLAS_STATE="$HOME/.atlas-arms-poc"
mkdir -p "$STATE/tasks"
chmod 700 "$STATE" "$STATE/tasks"

migrate_file() {
  name=$1
  if [ -s "$STATE/$name" ]; then
    return
  fi
  if [ -s "$OLD_POC_STATE/$name" ]; then
    cp "$OLD_POC_STATE/$name" "$STATE/$name"
    printf 'Migrated %s from %s.\n' "$name" "$OLD_POC_STATE"
    return
  fi
  if [ -s "$OLD_ATLAS_STATE/$name" ]; then
    cp "$OLD_ATLAS_STATE/$name" "$STATE/$name"
    printf 'Migrated %s from %s.\n' "$name" "$OLD_ATLAS_STATE"
  fi
}

migrate_file token
migrate_file servers.json

if [ -s "$STATE/token" ]; then
  TOKEN=$(cat "$STATE/token")
  printf 'Reusing existing local bridge token.\n'
else
  TOKEN=$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)
  printf '%s\n' "$TOKEN" > "$STATE/token"
  printf 'Generated new local bridge token.\n'
fi
chmod 600 "$STATE/token"

if [ ! -s "$STATE/servers.json" ]; then
  cat > "$STATE/servers.json" <<'JSON'
{
  "workspace": {
    "transport": "http",
    "endpoint": "http://127.0.0.1:8001/mcp",
    "timeout_s": 30,
    "enabled": true,
    "allowed_tools": [],
    "allow_verify": false,
    "verification_rules": [],
    "write": false,
    "allow_destructive": false,
    "roots": [],
    "approval_mode": "mutations",
    "always_approve_destructive": true
  }
}
JSON
  printf 'Created deny-by-default MCP server registry.\n'
else
  # Add new policy fields without granting new authority.
  STATE_FILE="$STATE/servers.json" python3 - <<'PY'
import json, os, pathlib, tempfile
p = pathlib.Path(os.environ["STATE_FILE"])
raw = json.loads(p.read_text())
for cfg in raw.values():
    if isinstance(cfg, dict):
        cfg.setdefault("allowed_tools", [])
        cfg.setdefault("allow_verify", False)
        cfg.setdefault("verification_rules", [])
        cfg.setdefault("write", False)
        cfg.setdefault("allow_destructive", False)
        cfg.setdefault("roots", [])
        cfg.setdefault("approval_mode", "mutations")
        cfg.setdefault("always_approve_destructive", True)
fd, name = tempfile.mkstemp(prefix="servers.", suffix=".json", dir=str(p.parent))
try:
    with os.fdopen(fd, "w") as f:
        json.dump(raw, f, indent=2)
        f.write("\n")
        f.flush(); os.fsync(f.fileno())
    os.chmod(name, 0o600)
    os.replace(name, p)
finally:
    try: os.unlink(name)
    except FileNotFoundError: pass
PY
  printf 'Reused existing MCP registry and added deny-by-default v0.9 fields where missing.\n'
fi
chmod 600 "$STATE/servers.json"

cat > "$ROOT/extension/config.js" <<EOF2
globalThis.LOCAL_MCP_BRIDGE_CONFIG = Object.freeze({
  endpoint: "http://127.0.0.1:8765",
  token: "$TOKEN"
});
EOF2
chmod 600 "$ROOT/extension/config.js"
chmod +x "$ROOT/daemon.py" "$ROOT/start.sh" "$ROOT/smoke_test.py" 2>/dev/null || true

printf '\nInstalled Local MCP Bridge v0.9.0.\n'
printf 'State: %s (0700)\n' "$STATE"
printf 'Security model: MCP tools remain deny-by-default; approval frequency is configurable per server.\n'
printf 'Next: restart ./start.sh, reload the unpacked extension, open Settings, Test & discover tools, configure roots, then allow only the tools you need.\n'
printf 'Extension directory: %s\n\n' "$ROOT/extension"
