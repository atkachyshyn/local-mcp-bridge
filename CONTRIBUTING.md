# Contributing

Local MCP Bridge is security-sensitive infrastructure. Small, reviewable changes are preferred over broad refactors.

## Before opening a pull request

Run:

```bash
python3 smoke_test.py
node browser_smoke_test.js
python3 -m py_compile daemon.py smoke_test.py
node --check extension/protocol.js
node --check extension/adapters/chatgpt.js
node --check extension/content.js
node --check extension/background.js
node --check extension/options.js
sh -n install.sh start.sh
python3 -m json.tool extension/manifest.json >/dev/null
```

## Security invariants

Changes should preserve these defaults unless the proposal explicitly changes the threat model:

- loopback-only bridge and MCP endpoints;
- deny-by-default allowed tools and roots;
- classification derived by the daemon, not the model;
- VERIFY granted only by local policy;
- no model-authored approval or authority fields;
- READ/VERIFY-only observation groups with whole-group preflight;
- exclusive WRITE/DESTRUCTIVE execution;
- no blind retry after ambiguous mutation outcomes;
- no bridge-native filesystem or shell executor;
- no unrestricted multi-operation workflow language.

Protocol or authorization changes should include regression tests and corresponding documentation updates.

## Secrets and local state

Never commit `extension/config.js`, bearer tokens, local state directories, real approval material, or private filesystem paths. Use examples with synthetic paths and credentials only.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than opening a detailed public issue.
