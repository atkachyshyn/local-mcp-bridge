# Security Policy

## Project status

Local MCP Bridge v0.9 is experimental security-sensitive developer tooling. It mediates model-proposed calls into local MCP servers, including optional commands and source mutations.

It is **not an operating-system sandbox** and should not be treated as one.

v0.9 has automated regression coverage and internal adversarial review, but its independent v0.9 security review is still pending. Use conservative local policy.

## Supported versions

Until v1.0, only the most recent tagged release is intended to receive security fixes.

## Recommended deployment boundary

- Bind the bridge daemon to loopback only.
- Configure only loopback MCP endpoints.
- Keep allowed roots as narrow as possible.
- Allow only tools you actually need.
- Prefer `approval_mode: "mutations"` during development.
- Keep `always_approve_destructive: true` unless you have a specific reason not to.
- Treat VERIFY as code execution, not as read-only access.
- Only allow VERIFY command prefixes for repositories and commands you trust.
- Do not expose the bridge port through a reverse proxy, tunnel, container port mapping, LAN bind, or public interface.
- Do not commit `extension/config.js`, `~/.local-mcp-bridge`, bearer tokens, approval state, or real local policy containing sensitive paths.

## Trust model

The cloud model is untrusted for authorization. It may request a server, tool, arguments, and observation grouping, but the daemon derives classification and enforces local server/tool/root/VERIFY/write/destructive policy.

WRITE and DESTRUCTIVE operations are exclusive. READ and locally authorized VERIFY calls may share an observation phase. Observation groups are fully preflighted before any member is dispatched.

VERIFY commands can still execute build scripts, tests, child processes, and network operations permitted by the host environment. Root validation constrains explicit path arguments; it does not confine arbitrary code executed by a permitted command.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the complete boundary model.

## Reporting a vulnerability

Please do not publish exploit details in a public issue.

If GitHub Private Vulnerability Reporting is enabled for this repository, use the repository **Security** tab to report the issue privately. If private reporting is not available, open a minimal public issue asking the maintainer for a private security contact channel without including vulnerability details, affected paths, proof-of-concept payloads, tokens, or secrets.

A useful report should include the affected version, expected security boundary, observed behavior, minimal reproduction conditions, and whether the issue can cause unauthorized READ, VERIFY, WRITE, DESTRUCTIVE, credential exposure, or non-loopback access.
