#!/usr/bin/env python3
from __future__ import annotations

import atexit
import hashlib
import http.client
import json
import os
import pathlib
import secrets
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterable

VERSION = "0.9.2.2"
LBP_VERSION = "1.3"
HOST = "127.0.0.1"
PORT = int(os.environ.get("LOCAL_MCP_BRIDGE_PORT", os.environ.get("ATLAS_ARMS_PORT", "8765")))
STATE_DIR = pathlib.Path.home() / ".local-mcp-bridge"
TOKEN_FILE = STATE_DIR / "token"
SERVERS_FILE = STATE_DIR / "servers.json"
TASK_DIR = STATE_DIR / "tasks"
CONVERSATION_DIR = STATE_DIR / "conversations"
MAX_REQUEST_BODY = 512 * 1024
MAX_MCP_BODY = 4 * 1024 * 1024
MAX_RESULT_STRING = 64 * 1024
MAX_TIMEOUT = 180
MCP_REQUESTED_PROTOCOL_VERSION = "2025-11-25"
MCP_CLIENT_IDLE_SECONDS = 300
APPROVAL_TOKEN_TTL_SECONDS = 120
SESSION_LEASE_TTL_SECONDS = 2 * 60 * 60
APPROVAL_MODES = {"all", "session", "mutations", "none"}
APPROVAL_ESCALATIONS = {"once", "chain", "session"}
RISK_RANK = {"read_only": 0, "verify": 1, "write": 2, "destructive": 3}
OBSERVE_CLASSIFICATIONS = {"read_only", "verify"}
MAX_OBSERVE_CALLS = 8
SHELL_META_CHARS = set(";&|`$><\n\r")
PATH_KEYS = {
    "path", "paths", "cwd", "root", "roots", "schematic", "board", "project_dir",
    "directory", "directories", "file_path", "filepath", "output_path", "input_path",
}


class McpHttpError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def ensure_state_permissions() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    TASK_DIR.mkdir(parents=True, exist_ok=True)
    CONVERSATION_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    os.chmod(TASK_DIR, 0o700)
    os.chmod(CONVERSATION_DIR, 0o700)
    for path in (TOKEN_FILE, SERVERS_FILE):
        if path.exists():
            os.chmod(path, 0o600)


def load_token() -> str:
    try:
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        raise SystemExit(f"Missing {TOKEN_FILE}. Run ./install.sh before starting the daemon.")
    if not token:
        raise SystemExit(f"Empty token file: {TOKEN_FILE}")
    return token


def ensure_loopback_http(endpoint: str) -> urllib.parse.ParseResult:
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != "http":
        raise ValueError("MCP transport only supports local http:// endpoints")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"MCP endpoint must be loopback-only, got: {endpoint}")
    if not parsed.port:
        raise ValueError(f"MCP endpoint must include an explicit port: {endpoint}")
    if parsed.username or parsed.password:
        raise ValueError("MCP endpoint must not contain userinfo")
    return parsed


def validate_server_name(name: Any) -> str:
    if not isinstance(name, str) or not name.strip():
        raise ValueError("MCP server id must be a non-empty string")
    value = name.strip()
    if len(value) > 64 or any(not (ch.isalnum() or ch in "._-") for ch in value):
        raise ValueError("MCP server id may contain only letters, numbers, dot, underscore and dash")
    return value


def normalize_root(raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("policy roots must be non-empty path strings")
    path = pathlib.Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError(f"policy root must be absolute: {raw!r}")
    return str(path.resolve(strict=False))


def validate_server_config(name: str, cfg: Any) -> dict[str, Any]:
    validate_server_name(name)
    if not isinstance(cfg, dict):
        raise ValueError(f"MCP server {name!r} config must be a JSON object")
    if cfg.get("transport", "http") != "http":
        raise ValueError(f"MCP server {name!r}: only transport='http' is supported")
    endpoint = cfg.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise ValueError(f"MCP server {name!r} requires endpoint")
    endpoint = endpoint.strip()
    ensure_loopback_http(endpoint)

    timeout_raw = cfg.get("timeout_s", 30)
    if timeout_raw in (None, ""):
        timeout_raw = 30
    try:
        timeout_s = int(timeout_raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"MCP server {name!r}: timeout_s must be an integer") from exc
    timeout_s = max(1, min(timeout_s, MAX_TIMEOUT))

    allowed_raw = cfg.get("allowed_tools", [])
    if not isinstance(allowed_raw, list) or not all(isinstance(x, str) and x.strip() for x in allowed_raw):
        raise ValueError(f"MCP server {name!r}: allowed_tools must be an array of tool names")
    allowed_tools = sorted(set(x.strip() for x in allowed_raw))

    roots_raw = cfg.get("roots", [])
    if not isinstance(roots_raw, list):
        raise ValueError(f"MCP server {name!r}: roots must be an array")
    roots = sorted(set(normalize_root(root) for root in roots_raw))

    write = bool(cfg.get("write", False))
    allow_verify = bool(cfg.get("allow_verify", False))
    allow_destructive = bool(cfg.get("allow_destructive", False))
    if allow_destructive and not write:
        raise ValueError(f"MCP server {name!r}: allow_destructive requires write=true")

    verification_raw = cfg.get("verification_rules", [])
    if not isinstance(verification_raw, list) or len(verification_raw) > 32:
        raise ValueError(f"MCP server {name!r}: verification_rules must be an array with at most 32 rules")
    verification_rules: list[dict[str, Any]] = []
    for index, raw_rule in enumerate(verification_raw):
        if not isinstance(raw_rule, dict):
            raise ValueError(f"MCP server {name!r}: verification_rules[{index}] must be an object")
        tool = raw_rule.get("tool")
        argument = raw_rule.get("argument", "command")
        cwd_argument = raw_rule.get("cwd_argument", "cwd")
        prefixes = raw_rule.get("argv_prefixes", [])
        if not isinstance(tool, str) or not tool.strip():
            raise ValueError(f"MCP server {name!r}: verification_rules[{index}].tool must be a non-empty string")
        if not isinstance(argument, str) or not argument.strip():
            raise ValueError(f"MCP server {name!r}: verification_rules[{index}].argument must be a non-empty string")
        if not isinstance(cwd_argument, str) or not cwd_argument.strip():
            raise ValueError(f"MCP server {name!r}: verification_rules[{index}].cwd_argument must be a non-empty string")
        if not isinstance(prefixes, list) or not prefixes or len(prefixes) > 32:
            raise ValueError(f"MCP server {name!r}: verification_rules[{index}].argv_prefixes must contain 1..32 argv prefixes")
        normalized_prefixes: list[list[str]] = []
        for prefix_index, prefix in enumerate(prefixes):
            if not isinstance(prefix, list) or not prefix or not all(isinstance(part, str) and part for part in prefix):
                raise ValueError(
                    f"MCP server {name!r}: verification_rules[{index}].argv_prefixes[{prefix_index}] "
                    "must be a non-empty string array"
                )
            if len(prefix) > 32 or any(len(part) > 256 for part in prefix):
                raise ValueError(f"MCP server {name!r}: verification argv prefix is too large")
            normalized_prefixes.append(list(prefix))
        verification_rules.append({
            "tool": tool.strip(),
            "argument": argument.strip(),
            "cwd_argument": cwd_argument.strip(),
            "argv_prefixes": normalized_prefixes,
        })
    if verification_rules and not allow_verify:
        # Keeping rules while disabled is useful for toggling policy without losing configuration.
        pass

    approval_mode = cfg.get("approval_mode", "mutations")
    if approval_mode not in APPROVAL_MODES:
        raise ValueError(
            f"MCP server {name!r}: approval_mode must be one of {sorted(APPROVAL_MODES)}"
        )
    approval_escalation = cfg.get("approval_escalation", "chain")
    if approval_escalation not in APPROVAL_ESCALATIONS:
        raise ValueError(
            f"MCP server {name!r}: approval_escalation must be one of {sorted(APPROVAL_ESCALATIONS)}"
        )
    always_approve_destructive = bool(cfg.get("always_approve_destructive", True))

    return {
        "transport": "http",
        "endpoint": endpoint,
        "timeout_s": timeout_s,
        "enabled": bool(cfg.get("enabled", True)),
        "allowed_tools": allowed_tools,
        "allow_verify": allow_verify,
        "verification_rules": verification_rules,
        "write": write,
        "allow_destructive": allow_destructive,
        "roots": roots,
        "approval_mode": approval_mode,
        "approval_escalation": approval_escalation,
        "always_approve_destructive": always_approve_destructive,
    }


def validate_servers_payload(raw: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        raise ValueError("servers must be a JSON object")
    if len(raw) > 32:
        raise ValueError("at most 32 MCP servers may be configured")
    return {validate_server_name(name): validate_server_config(name, cfg) for name, cfg in raw.items()}


def load_servers() -> dict[str, dict[str, Any]]:
    try:
        raw = json.loads(SERVERS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {SERVERS_FILE}: {exc}") from exc
    try:
        return validate_servers_payload(raw)
    except ValueError as exc:
        raise SystemExit(f"Invalid server configuration: {exc}") from exc


def json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def atomic_write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=str(path.parent), prefix=f".{path.name}.", delete=False
        ) as tmp:
            json.dump(value, tmp, indent=2, ensure_ascii=False)
            tmp.write("\n")
            tmp.flush()
            os.fsync(tmp.fileno())
            tmp_name = tmp.name
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
        tmp_name = None
    finally:
        if tmp_name:
            try:
                os.unlink(tmp_name)
            except FileNotFoundError:
                pass


# --- Conversation identity ---------------------------------------------------
#
# v0.9.2 conversation identity. Two shapes, distinguishable by prefix:
#
#   conv-<32 hex>   canonical. Derived by the extension from a stable provider
#                   conversation identifier that the URL exposes publicly
#                   (ChatGPT: the /c/<uuid> path segment). SHA-256, not FNV-1a.
#
#   prov-<32 hex>   provisional. A per-tab identity used before the provider has
#                   assigned a conversation id (a brand new chat at "/", or a
#                   project route that carries no conversation id). Provisional
#                   state is per tab, never shared, and carries no approval
#                   leases.
#
# The daemon treats both as opaque. It only needs the prefix to enforce the
# migration rule in bind_conversation: provisional state may be promoted to a
# canonical id exactly once, and canonical state is never copied anywhere.

CONVERSATION_ID_PREFIXES = ("conv-", "prov-")
CONVERSATION_SCHEMA = 2

PHASES = {
    "disabled",
    "idle",
    "awaiting_assistant",
    "task_registered",
    "executing",
    "result_ready",
    "checkpoint",
    "stopped",
    "unknown",
}

EXECUTION_STATUSES = {"registered", "running", "completed", "error", "unknown"}
DELIVERY_STATUSES = {"none", "inserted", "observed", "submitted", "failed", "withheld"}
PLAN_ITEM_STATUSES = {"pending", "current", "completed", "error", "unknown", "skipped"}
OUTPUT_STATUSES = {"pending", "produced", "failed", "unknown"}

# recent_tasks is a bounded presentation projection. No staleness, currentness or
# duplicate-id decision may read it -- those all resolve against the durable
# conversation-scoped journal. See task_journal_* below.
MAX_RECENT_TASKS = 64
OWNER_LEASE_SECONDS = 30

# A registration that was never dispatched and has gone quiet must not be able to
# hold the chain open forever. The coordinator is expected to call abandon_task
# when the user denies a task or execution fails; this bound is the failsafe for
# when it cannot (tab closed mid-dialog, crash between register and run).
REGISTRATION_STALE_SECONDS = 15 * 60


def validate_conversation_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("conversation_id must be a non-empty string")
    value = value.strip()
    if not value.startswith(CONVERSATION_ID_PREFIXES):
        raise ValueError("conversation_id must be a canonical 'conv-' or provisional 'prov-' identity")
    body = value[5:]
    if len(body) != 32 or any(ch not in "0123456789abcdef" for ch in body):
        raise ValueError("conversation_id body must be 32 lowercase hex characters")
    return value


def conversation_is_provisional(conversation_id: str) -> bool:
    return conversation_id.startswith("prov-")


def conversation_state_key(conversation_id: str) -> str:
    return hashlib.sha256(conversation_id.encode("utf-8")).hexdigest()


def conversation_state_lock(conversation_id: str) -> threading.RLock:
    key = conversation_state_key(conversation_id)
    with CONVERSATION_LOCKS_GUARD:
        return CONVERSATION_LOCKS.setdefault(key, threading.RLock())


def conversation_state_path(conversation_id: str) -> pathlib.Path:
    return CONVERSATION_DIR / f"{conversation_state_key(conversation_id)}.json"


def default_conversation_state(conversation_id: str) -> dict[str, Any]:
    return {
        "schema": CONVERSATION_SCHEMA,
        "conversation_id": conversation_id,
        "revision": 0,

        # Persistent chat properties. Deliberately not collapsed into one
        # "active" boolean: whether the bridge is switched on for this chat and
        # where the chat is in an execution lifecycle are different questions.
        "enabled": False,
        "workflow_attached": False,
        "mode": "manual",
        "checkpoint_size": 12,
        "unknown_recovery": "manual",

        "phase": "disabled",
        "stopped_reason": None,

        # Enable baseline. Historical tasks must never execute, and "the turns
        # currently rendered" is exactly the quantity provider virtualization
        # destroys -- enabling while scrolled up would otherwise record a
        # baseline at an old turn and make everything after it eligible.
        #
        # So the baseline is established by OBSERVATION, not enumeration: after
        # enable, no chain exists until the coordinator arms a genuine local
        # send and a new user turn is then observed. Scrolling can never arm.
        "baseline_at": None,
        "pending_human_send": False,

        "last_user_turn_id": None,
        "last_assistant_turn_id": None,

        "active_chain": None,
        "current_task_id": None,
        "current_registration": None,

        "recent_tasks": [],
        "total_task_count": 0,
        "plan": None,
        "outputs": [],
        "context": {"sources": [], "constraints": []},
        "owner": None,
        "updated_at": int(time.time()),
    }


def load_conversation_state(conversation_id: str) -> dict[str, Any]:
    conversation_id = validate_conversation_id(conversation_id)
    path = conversation_state_path(conversation_id)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default_conversation_state(conversation_id)
    if not isinstance(raw, dict) or raw.get("conversation_id") != conversation_id:
        raise ValueError("invalid persisted conversation state")
    if int(raw.get("schema", 1)) != CONVERSATION_SCHEMA:
        # A v1 state file cannot be safely upgraded: it has no baseline and no
        # turn lineage, so promoting it would make its historical tasks eligible.
        # Start clean and fail closed instead.
        return default_conversation_state(conversation_id)
    return {**default_conversation_state(conversation_id), **raw}


def save_conversation_state(state: dict[str, Any]) -> dict[str, Any]:
    conversation_id = validate_conversation_id(state.get("conversation_id"))
    state = dict(state)
    state["conversation_id"] = conversation_id
    state["schema"] = CONVERSATION_SCHEMA
    state["revision"] = int(state.get("revision", 0)) + 1
    state["updated_at"] = int(time.time())
    atomic_write_json(conversation_state_path(conversation_id), state)
    return state


def context_source_id(kind: str, path: str, server: str) -> str:
    digest = hashlib.sha256(f"{kind}\0{server}\0{path}".encode("utf-8")).hexdigest()
    return f"ctx-{digest[:24]}"


def folder_label(path: str) -> str:
    name = pathlib.Path(path).name
    return name or path


def conversation_context_state(state: dict[str, Any]) -> dict[str, Any]:
    raw = state.get("context") if isinstance(state.get("context"), dict) else {}
    sources_raw = raw.get("sources", [])
    constraints_raw = raw.get("constraints", [])
    sources: list[dict[str, Any]] = []
    if isinstance(sources_raw, list):
        for item in sources_raw:
            if not isinstance(item, dict):
                continue
            if item.get("kind") != "folder":
                continue
            path = item.get("path")
            server = item.get("server")
            source_id = item.get("id")
            if not isinstance(path, str) or not path.strip():
                continue
            if not isinstance(server, str) or not server.strip():
                continue
            if not isinstance(source_id, str) or not source_id.startswith("ctx-"):
                source_id = context_source_id("folder", path, server)
            label = item.get("label")
            sources.append({
                "id": source_id[:80],
                "kind": "folder",
                "label": label.strip()[:200] if isinstance(label, str) and label.strip() else folder_label(path),
                "path": path,
                "server": server.strip()[:64],
                "accessible": item.get("accessible") is not False,
                "origin": "user",
                "removable": True,
                "added_at": int(item.get("added_at", 0) or 0),
            })
    constraints = [
        item.strip()[:300]
        for item in constraints_raw
        if isinstance(item, str) and item.strip()
    ] if isinstance(constraints_raw, list) else []
    return {"sources": sources[-64:], "constraints": constraints[-64:]}


def _path_within_root(path: pathlib.Path, root: pathlib.Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def match_configured_context_root(path: Any, preferred_server: Any = None) -> tuple[str, str, str] | None:
    if not isinstance(path, str) or not path.strip():
        raise ValueError("context folder path must be a non-empty string")
    selected = pathlib.Path(path).expanduser()
    if not selected.is_absolute():
        raise ValueError("context folder path must be absolute")
    resolved = selected.resolve(strict=False)

    preferred = preferred_server.strip() if isinstance(preferred_server, str) and preferred_server.strip() else None
    matches: list[tuple[int, str, str]] = []
    for server, cfg in sorted(servers_snapshot().items()):
        if preferred and server != preferred:
            continue
        if not cfg.get("enabled", True):
            continue
        for root_raw in cfg.get("roots", []):
            root = pathlib.Path(root_raw).expanduser().resolve(strict=False)
            if _path_within_root(resolved, root):
                matches.append((len(root.parts), server, str(root)))
    if not matches:
        return None
    _, server, root = sorted(matches, key=lambda item: item[0], reverse=True)[0]
    return str(resolved), server, root


def context_source_for_folder(path: Any, preferred_server: Any = None, label: Any = None) -> dict[str, Any]:
    match = match_configured_context_root(path, preferred_server)
    if match is None:
        raise ValueError("context_folder_outside_roots: Folder is outside the currently allowed MCP roots.")
    resolved, server, root = match
    text_label = label.strip()[:200] if isinstance(label, str) and label.strip() else folder_label(resolved)
    return {
        "id": context_source_id("folder", resolved, server),
        "kind": "folder",
        "label": text_label,
        "path": resolved,
        "server": server,
        "accessible": True,
        "origin": "user",
        "removable": True,
        "root": root,
    }


def refresh_context_source_access(source: dict[str, Any]) -> dict[str, Any]:
    out = dict(source)
    try:
        match = match_configured_context_root(out.get("path"), out.get("server"))
    except ValueError:
        match = None
    out["accessible"] = match is not None
    if match is not None:
        out["path"], out["server"], out["root"] = match
    else:
        out.pop("root", None)
    return out


def configured_context_workspaces() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for server, cfg in sorted(servers_snapshot().items()):
        if not cfg.get("enabled", True):
            continue
        for root in cfg.get("roots", []):
            try:
                source = context_source_for_folder(root, server)
            except ValueError:
                continue
            key = source["id"]
            if key in seen:
                continue
            seen.add(key)
            entries.append(source)
    return entries


def _folder_picker_result(path: str) -> dict[str, Any]:
    path = path.strip()
    if not path:
        return {"cancelled": True}
    resolved = pathlib.Path(path).expanduser().resolve(strict=False)
    if not resolved.is_absolute():
        raise ValueError("folder_picker_failed: selected folder was not an absolute path")
    return {"cancelled": False, "path": str(resolved)}


def choose_context_folder_native() -> dict[str, Any]:
    """Open a local folder picker from an explicit browser click."""
    if sys.platform == "darwin":
        script = 'POSIX path of (choose folder with prompt "Choose a folder to add to Context")'
        proc = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        if proc.returncode == 0:
            return _folder_picker_result(proc.stdout)
        stderr = (proc.stderr or "").strip()
        if proc.returncode == 1 or "User canceled" in stderr or "-128" in stderr:
            return {"cancelled": True}
        raise ValueError(f"folder_picker_failed: {stderr or 'osascript failed'}")

    if sys.platform.startswith("win"):
        command = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$d.Description = 'Choose a folder to add to Context'; "
            "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
            "{ [Console]::WriteLine($d.SelectedPath) }"
        )
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", command],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        if proc.returncode == 0:
            return _folder_picker_result(proc.stdout)
        raise ValueError(f"folder_picker_failed: {(proc.stderr or '').strip() or 'PowerShell failed'}")

    for command in (
        ["zenity", "--file-selection", "--directory", "--title=Choose a folder to add to Context"],
        ["kdialog", "--getexistingdirectory", str(pathlib.Path.home())],
    ):
        try:
            proc = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
        except FileNotFoundError:
            continue
        if proc.returncode == 0:
            return _folder_picker_result(proc.stdout)
        if proc.returncode in {1, 255}:
            return {"cancelled": True}
    raise ValueError("folder_picker_unavailable: no native folder picker is available")


def conversation_context_projection(state: dict[str, Any]) -> dict[str, Any]:
    plan = state.get("plan") if isinstance(state.get("plan"), dict) else {}
    plan_context = plan.get("context") if isinstance(plan.get("context"), dict) else {}
    resources = list(plan_context.get("resources", [])) if isinstance(plan_context.get("resources"), list) else []
    constraints = list(plan_context.get("constraints", [])) if isinstance(plan_context.get("constraints"), list) else []
    stored = conversation_context_state(state)
    constraints.extend(stored["constraints"])
    try:
        servers = [
            {"kind": "mcp", "label": name}
            for name, cfg in sorted(servers_snapshot().items())
            if cfg.get("enabled", True)
        ]
    except Exception:
        servers = []
    if not any(item.get("kind") == "workspace" for item in resources if isinstance(item, dict)):
        resources.insert(0, {"kind": "workspace", "label": "local-mcp-bridge"})
    if not any(str(item).startswith("Checkpoint =") for item in constraints):
        constraints.append(f"Checkpoint = {int(state.get('checkpoint_size', 12))}")
    sources: list[dict[str, Any]] = []
    for item in resources:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind", "resource"))[:48]
        label = str(item.get("label", ""))[:200]
        if not label:
            continue
        source = {
            "id": f"plan-{hashlib.sha256(canonical_json(item).encode('utf-8')).hexdigest()[:24]}",
            "kind": kind,
            "label": label,
            "origin": "plan",
            "accessible": True,
            "removable": False,
        }
        if isinstance(item.get("ref"), str) and item.get("ref").strip():
            source["ref"] = item["ref"].strip()[:1000]
        sources.append(source)
    sources.extend(refresh_context_source_access(source) for source in stored["sources"])
    return {
        "sources": sources,
        "resources": resources,
        "constraints": constraints,
        "servers": servers,
    }


def conversation_public_state(state: dict[str, Any]) -> dict[str, Any]:
    out = dict(state)
    chain = state.get("active_chain") or {}
    approval_scope_id = chain.get("approval_scope_id") or chain.get("chain_id")
    window = int(chain.get("window", 0))
    # Derived here and nowhere else. Human-turn chain identity is deliberately
    # separate from checkpoint approval scope, which survives genuine follow-up
    # turns until the configured checkpoint boundary is reached.
    out["approval_window_id"] = f"{approval_scope_id}.w{window}" if approval_scope_id else None
    owner = state.get("owner") or {}
    out["owner"] = {"expires_at": owner.get("expires_at")} if owner else None
    out["context"] = conversation_context_projection(state)
    return out


class ConversationConflict(ValueError):
    """Optimistic-concurrency failure. Carries the current state for merge."""

    def __init__(self, state: dict[str, Any]):
        super().__init__(
            f"conversation_revision_conflict: expected revision did not match "
            f"current revision {state.get('revision')}"
        )
        self.state = state


def _owner_active(state: dict[str, Any], now: float) -> dict[str, Any] | None:
    owner = state.get("owner")
    if not isinstance(owner, dict):
        return None
    if float(owner.get("expires_at", 0)) <= now:
        return None
    return owner


# Actions that advance the state machine on the coordinator's behalf. Everything
# else -- get, configure, enable, disable, stop, context edits -- is a human
# action and is always allowed.
OWNER_GUARDED_ACTIONS = {
    "arm_human_send", "observe_user_turn", "observe_assistant_turn",
    "assistant_no_task", "register_task", "abandon_task",
    "task_execution_status", "task_delivery_status", "observe_submission", "acknowledge_submission",
    "acknowledge_unknown",
}


def _require_owner(state: dict[str, Any], tab_token: Any) -> None:
    """Two tabs on one conversation are two event pumps against one state machine.

    Serializing inside a tab does not help, so the daemon arbitrates: one tab
    holds a short renewable lease and only that tab may drive execution. A
    non-owner tab renders read-only.
    """
    now = time.time()
    owner = _owner_active(state, now)
    if owner is None:
        return
    if not isinstance(tab_token, str) or tab_token != owner.get("tab_token"):
        raise ValueError(
            "conversation_not_owner: another tab is driving this conversation"
        )


def _new_chain(state: dict[str, Any], human_turn_id: str) -> None:
    previous = state.get("active_chain") if isinstance(state.get("active_chain"), dict) else {}
    state["active_chain"] = {
        "chain_id": secrets.token_hex(16),
        "approval_scope_id": previous.get("approval_scope_id") or previous.get("chain_id") or secrets.token_hex(16),
        "human_turn_id": human_turn_id,
        "window": int(previous.get("window", 0)),
        "window_limit": int(previous.get("window_limit", state.get("checkpoint_size", 12))),
        "window_task_count": int(previous.get("window_task_count", 0)),
        "total_task_count": int(state.get("total_task_count", 0)),
        "checkpoint_resize_pending": bool(previous.get("checkpoint_resize_pending", False)),
    }
    state["current_task_id"] = None
    state["current_registration"] = None
    state["stopped_reason"] = None


def update_conversation_state(conversation_id: str, action: str, payload: dict[str, Any]) -> dict[str, Any]:
    conversation_id = validate_conversation_id(conversation_id)
    if action not in CONVERSATION_ACTIONS:
        raise ValueError(f"unsupported conversation state action {action!r}")
    handler = CONVERSATION_ACTIONS[action]

    with conversation_state_lock(conversation_id):
        state = load_conversation_state(conversation_id)

        if action == "get":
            return conversation_public_state(state)

        # Diagnostic correlation only. Never log task bodies, MCP arguments,
        # approval tokens, or other payload contents.
        debug_extra: dict[str, Any] = {}
        turn_id = payload.get("turn_id")
        if isinstance(turn_id, str) and turn_id:
            debug_extra["turn_id"] = turn_id[:256]
        assistant_turn_id = payload.get("assistant_turn_id")
        if isinstance(assistant_turn_id, str) and assistant_turn_id:
            debug_extra["assistant_turn_id"] = assistant_turn_id[:256]
        task = payload.get("task")
        if isinstance(task, dict) and isinstance(task.get("id"), str):
            debug_extra["task_id"] = task["id"][:256]
        registration = payload.get("registration")
        if isinstance(registration, str) and registration:
            debug_extra["registration"] = registration[:64]

        _debug_state(f"{action}_before", state, **debug_extra)

        try:
            expected = payload.get("expected_revision")
            if expected is not None:
                if int(expected) != int(state.get("revision", 0)):
                    raise ConversationConflict(conversation_public_state(state))

            if action in OWNER_GUARDED_ACTIONS:
                _require_owner(state, payload.get("tab_token"))

            extra = handler(state, payload) or {}
            state = save_conversation_state(state)
        except Exception as exc:
            _debug_state(
                f"{action}_error",
                state,
                error=f"{type(exc).__name__}: {exc}",
                **debug_extra,
            )
            raise

        _debug_state(f"{action}_after", state, **debug_extra)

        public = conversation_public_state(state)
        public.update(extra)
        return public


# --- Conversation state machine actions --------------------------------------


def _act_claim_owner(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    tab_token = payload.get("tab_token")
    if not isinstance(tab_token, str) or not tab_token.strip():
        raise ValueError("claim_owner requires tab_token")
    tab_token = tab_token.strip()[:128]
    now = time.time()
    owner = _owner_active(state, now)
    # A page that just loaded IS the live tab, so it claims with takeover. A
    # periodic renewal does not, so a second live tab cannot ping-pong the lease.
    # Without takeover, reloading a tab locked the user out for the whole lease.
    if owner is not None and owner.get("tab_token") != tab_token and not payload.get("takeover"):
        return {"owner_granted": False, "owner_held": True}
    state["owner"] = {"tab_token": tab_token, "expires_at": now + OWNER_LEASE_SECONDS}
    return {"owner_granted": True, "owner_held": False}


def _act_release_owner(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    owner = state.get("owner") or {}
    if owner.get("tab_token") == payload.get("tab_token"):
        state["owner"] = None
    return {}


def _act_configure(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    mode = payload.get("mode", state.get("mode", "manual"))
    if mode not in {"manual", "auto_continue"}:
        raise ValueError("mode must be manual or auto_continue")
    checkpoint_size = int(payload.get("checkpoint_size", state.get("checkpoint_size", 12)))
    if checkpoint_size < 1 or checkpoint_size > 100:
        raise ValueError("checkpoint_size must be 1..100")
    unknown_recovery = payload.get("unknown_recovery", state.get("unknown_recovery", "manual"))
    if unknown_recovery not in {"manual", "auto_continue"}:
        raise ValueError("unknown_recovery must be manual or auto_continue")
    state["mode"] = mode
    state["checkpoint_size"] = checkpoint_size
    state["unknown_recovery"] = unknown_recovery
    chain = state.get("active_chain")
    if isinstance(chain, dict):
        # A shrink that makes the current window already full/overfull never
        # rolls retroactively and must not pre-roll merely because another task
        # is registered. The next terminal task boundary performs the rollover.
        previous_limit = int(chain.get("window_limit", state.get("checkpoint_size", 12)))
        current_count = int(chain.get("window_task_count", 0))
        chain["checkpoint_resize_pending"] = checkpoint_size < previous_limit and current_count >= checkpoint_size
        chain["window_limit"] = checkpoint_size
    return {}


def _act_add_context_source(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    kind = payload.get("kind", "folder")
    if kind != "folder":
        raise ValueError("v0.9.2 context sources support folders only")
    source = context_source_for_folder(
        payload.get("path"),
        payload.get("server"),
        payload.get("label"),
    )
    source["added_at"] = int(time.time())

    context = conversation_context_state(state)
    existing = context["sources"]
    updated: list[dict[str, Any]] = []
    replaced = False
    for item in existing:
        if item.get("id") == source["id"]:
            updated.append({**item, **source, "added_at": int(item.get("added_at", source["added_at"]))})
            replaced = True
        else:
            updated.append(item)
    if not replaced:
        if len(updated) >= 64:
            raise ValueError("conversation context supports at most 64 user-added sources")
        updated.append(source)
    state["context"] = {"sources": updated, "constraints": context["constraints"]}
    return {"context_source": source}


def _act_remove_context_source(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    source_id = payload.get("source_id") or payload.get("id")
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("remove_context_source requires source_id")
    source_id = source_id.strip()[:80]
    context = conversation_context_state(state)
    updated = [source for source in context["sources"] if source.get("id") != source_id]
    state["context"] = {"sources": updated, "constraints": context["constraints"]}
    return {"removed": len(updated) != len(context["sources"])}


def _act_enable(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Ask for the workflow instructions to be attached to the next human turn.

    `enabled` no longer authorises execution -- it only means "send the model the
    instructions". Execution is gated on an ARMED genuine human send producing a
    chain, which is what keeps historical and unarmed turns unexecutable:
    scrolling, rediscovery and another tab still cannot arm one.

    Deliberately non-destructive. This used to clear the active chain, plan and
    outputs, so pressing Enable mid-run threw the run away.
    """
    state["enabled"] = True
    state["workflow_attached"] = False
    if state.get("baseline_at") is None:
        state["baseline_at"] = int(time.time())
    if state.get("phase") == "disabled":
        state["phase"] = "idle"
    return {}


def _act_disable(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """The actual off switch: no instructions, and stop the run."""
    state["enabled"] = False
    state["active_chain"] = None
    state["current_task_id"] = None
    state["current_registration"] = None
    state["plan"] = None
    state["pending_human_send"] = False
    state["phase"] = "disabled"
    return {}


def _act_workflow_attached(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    state["workflow_attached"] = bool(payload.get("attached", True))
    return {}


def _act_arm_human_send(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """The coordinator observed a genuine local send about to happen.

    This only ARMS the daemon. It does not create a chain and does not rotate
    anything, so a keydown that never becomes a turn costs nothing. The chain is
    created later, by observe_user_turn, when the provider has actually produced
    the turn. Scrolling, virtualization and rediscovery can never arm.
    """
    if not state.get("enabled"):
        state["pending_human_send"] = False
        return {"armed": False, "reason": "disabled"}
    state["pending_human_send"] = True
    return {"armed": True}


def _act_observe_user_turn(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    turn_id = payload.get("turn_id")
    if not isinstance(turn_id, str) or not turn_id.strip():
        raise ValueError("observe_user_turn requires turn_id")
    turn_id = turn_id.strip()[:256]

    if turn_id == state.get("last_user_turn_id"):
        return {"turn": "known"}

    if not state.get("enabled"):
        state["pending_human_send"] = False
        state["last_user_turn_id"] = turn_id
        return {"turn": "disabled"}

    if not state.get("pending_human_send"):
        # A user turn we did not arm. Either it is a bridge result turn (handled
        # by acknowledge_submission), a turn from another tab, or a turn scrolled
        # into view. None of those may start a chain.
        state["last_user_turn_id"] = turn_id
        return {"turn": "unarmed"}

    state["pending_human_send"] = False
    state["last_user_turn_id"] = turn_id
    _new_chain(state, turn_id)
    state["phase"] = "awaiting_assistant"
    return {"turn": "new_chain"}


def _act_observe_assistant_turn(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    turn_id = payload.get("turn_id")
    if not isinstance(turn_id, str) or not turn_id.strip():
        raise ValueError("observe_assistant_turn requires turn_id")
    state["last_assistant_turn_id"] = turn_id.strip()[:256]
    return {}


def _act_assistant_no_task(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    if state.get("phase") == "awaiting_assistant":
        state["phase"] = "idle"
    return {}


def _act_stop(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    state["phase"] = "stopped"
    reason = payload.get("reason")
    state["stopped_reason"] = str(reason)[:200] if isinstance(reason, str) and reason.strip() else "stopped_by_user"
    state["pending_human_send"] = False
    return {}


CONVERSATION_ACTIONS: dict[str, Any] = {
    "get": None,
    "claim_owner": _act_claim_owner,
    "release_owner": _act_release_owner,
    "configure": _act_configure,
    "add_context_source": _act_add_context_source,
    "remove_context_source": _act_remove_context_source,
    "enable": _act_enable,
    "disable": _act_disable,
    "workflow_attached": _act_workflow_attached,
    "arm_human_send": _act_arm_human_send,
    "observe_user_turn": _act_observe_user_turn,
    "observe_assistant_turn": _act_observe_assistant_turn,
    "assistant_no_task": _act_assistant_no_task,
    "stop": _act_stop,
}


def bind_conversation(provisional_id: str, canonical_id: str) -> dict[str, Any]:
    """Promote per-tab provisional state to a canonical conversation identity.

    Only provisional state may be migrated, it may be migrated only once, and it
    may never overwrite existing canonical state. Navigation between two
    canonical conversations never copies anything.
    """
    provisional_id = validate_conversation_id(provisional_id)
    canonical_id = validate_conversation_id(canonical_id)
    if not conversation_is_provisional(provisional_id):
        raise ValueError("bind_conversation source must be a provisional identity")
    if conversation_is_provisional(canonical_id):
        raise ValueError("bind_conversation target must be a canonical identity")

    first, second = sorted([provisional_id, canonical_id])
    with conversation_state_lock(first), conversation_state_lock(second):
        canonical_path = conversation_state_path(canonical_id)
        if canonical_path.exists():
            # Two tabs both started at "/" and both landed here, or this tab
            # already bound. Fail closed: adopt the existing canonical state.
            return {**conversation_public_state(load_conversation_state(canonical_id)), "bound": False}

        source = load_conversation_state(provisional_id)
        migrated = dict(source)
        migrated["conversation_id"] = canonical_id
        migrated["revision"] = 0
        migrated["bound_from_provisional"] = True
        migrated = save_conversation_state(migrated)

        # Retarget the journals written under the provisional identity so a task
        # registered before the URL settled is still resolvable afterwards.
        rebind_task_journals(provisional_id, canonical_id)

        provisional_path = conversation_state_path(provisional_id)
        try:
            provisional_path.unlink()
        except FileNotFoundError:
            pass
        return {**conversation_public_state(migrated), "bound": True}


# --- Conversation-scoped task journal ----------------------------------------
#
# The journal key is SHA256(conversation_id + NUL + task_id). Keying by task_id
# alone let a model-chosen, low-entropy id ("task1") collide across chats, and
# because replay resolved before policy evaluation, a collision returned another
# conversation's stored result with no approval and no policy check. Scoping the
# key closes the collision; resolving replay AFTER policy re-evaluation closes
# the bypass.
#
# Lifecycle:
#   registered -> executing -> completed | error | unknown
#
# Phase is an explicit field, never inferred from file existence. That
# distinction is what makes crash recovery deterministic:
#   registered, no dispatch  -> safe to execute
#   executing, no result     -> ambiguous, never retried automatically
#   result present           -> replay without re-entering MCP


def journal_key(conversation_id: str, task_id: str) -> str:
    material = conversation_id.encode("utf-8") + b"\x00" + task_id.encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def journal_path(key: str) -> pathlib.Path:
    return TASK_DIR / f"{key}.journal.json"


def registration_ref_path(registration_id: str) -> pathlib.Path:
    return TASK_DIR / f"reg-{registration_id}.ref.json"


def task_lock(key: str) -> threading.RLock:
    with TASK_LOCKS_GUARD:
        return TASK_LOCKS.setdefault(key, threading.RLock())


def load_journal(key: str) -> dict[str, Any] | None:
    try:
        raw = json.loads(journal_path(key).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    return raw if isinstance(raw, dict) else None


def save_journal(record: dict[str, Any]) -> dict[str, Any]:
    record = dict(record)
    record["updated_at"] = int(time.time())
    atomic_write_json(journal_path(record["key"]), record)
    return record


def resolve_registration(registration_id: Any) -> dict[str, Any]:
    if not isinstance(registration_id, str) or not registration_id.strip():
        raise ValueError("registration is required")
    registration_id = registration_id.strip()
    if len(registration_id) != 32 or any(ch not in "0123456789abcdef" for ch in registration_id):
        raise ValueError("invalid registration handle")
    try:
        ref = json.loads(registration_ref_path(registration_id).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError("unknown registration handle")
    record = load_journal(ref.get("key", ""))
    if record is None or record.get("registration_id") != registration_id:
        raise ValueError("unknown registration handle")
    return record


def rebind_task_journals(provisional_id: str, canonical_id: str) -> None:
    """Re-key journals written before the provider assigned a conversation id."""
    for path in list(TASK_DIR.glob("*.journal.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(record, dict) or record.get("conversation_id") != provisional_id:
            continue
        new_key = journal_key(canonical_id, record["task_id"])
        record["conversation_id"] = canonical_id
        record["key"] = new_key
        atomic_write_json(journal_path(new_key), record)
        atomic_write_json(
            registration_ref_path(record["registration_id"]),
            {"key": new_key, "conversation_id": canonical_id, "task_id": record["task_id"]},
        )
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def _act_register_task(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Register the current assistant task and return an opaque handle.

    The full task is normalized and persisted HERE, once. Preview, approval and
    execution then refer to the handle, so the browser cannot resupply or mutate
    task content between phases.

    Registration is idempotent on (assistant_turn_id, digest) in ANY phase. The
    phase gate applies to CREATING a registration, never to resolving one --
    otherwise a reload during task_registered would rediscover its own task and
    be refused with no way back.
    """
    if not state.get("enabled"):
        raise ValueError("bridge is disabled for this conversation")
    chain = state.get("active_chain")
    if not isinstance(chain, dict):
        # The chain IS the authorisation: it exists only after THIS tab armed a
        # genuine human send and the provider then produced that turn.
        raise ValueError("no active chain; a task can only be registered after a genuine human turn")
    if state.get("phase") == "stopped":
        raise ValueError("conversation chain is stopped")

    assistant_turn_id = payload.get("assistant_turn_id")
    if not isinstance(assistant_turn_id, str) or not assistant_turn_id.strip():
        raise ValueError("register_task requires assistant_turn_id")
    assistant_turn_id = assistant_turn_id.strip()[:256]

    task = normalize_task(payload.get("task"))
    conversation_id = state["conversation_id"]
    key = journal_key(conversation_id, task["id"])
    digest = task_digest(task)

    with task_lock(key):
        existing = load_journal(key)
        if existing is not None:
            if existing.get("digest") != digest:
                raise ValueError(
                    f"task id {task['id']!r} already exists in this conversation with different "
                    "content; use a new task id"
                )
            if existing.get("assistant_turn_id") != assistant_turn_id:
                raise ValueError(
                    f"task id {task['id']!r} is registered against a different assistant turn"
                )
            return {"registration": "known", "task": _journal_public(existing)}

        # Creating a new registration requires the awaiting-assistant phase --
        # unless the phase is held open by a registration that never dispatched
        # and has gone stale, in which case that one is released first.
        if state.get("phase") != "awaiting_assistant":
            superseded = _maybe_release_stale_registration(state)
            if not superseded:
                raise ValueError(
                    f"conversation phase {state.get('phase')!r} does not accept a new task registration"
                )

        window_limit = int(chain.get("window_limit", state.get("checkpoint_size", 12)))
        if int(chain.get("window_task_count", 0)) >= window_limit and not chain.get("checkpoint_resize_pending"):
            # This version has no persisted checkpoint artifact. Reaching the
            # window limit therefore advances bookkeeping instead of pausing.
            chain["window"] = int(chain.get("window", 0)) + 1
            chain["window_task_count"] = 0
            chain["window_limit"] = int(state.get("checkpoint_size", 12))
            evict_superseded_chain_leases(
                chain.get("approval_scope_id") or chain.get("chain_id"),
                int(chain["window"]),
            )
            window_limit = int(chain["window_limit"])

        _register_plan_if_needed(state, task, chain)

        position = int(chain.get("window_task_count", 0)) + 1
        recent_sequence = max(
            (int(item.get("sequence") or 0) for item in state.get("recent_tasks", []) if isinstance(item, dict)),
            default=0,
        )
        sequence = max(
            int(state.get("total_task_count", 0)),
            int(chain.get("total_task_count", 0)),
            recent_sequence,
        ) + 1
        registration_id = secrets.token_hex(16)
        record = {
            "key": key,
            "registration_id": registration_id,
            "conversation_id": conversation_id,
            "task_id": task["id"],
            "assistant_turn_id": assistant_turn_id,
            "digest": digest,
            "task": task,
            "title": task.get("title"),
            "chain_id": chain.get("chain_id"),
            "window": int(chain.get("window", 0)),
            "window_position": position,
            "sequence": sequence,
            "plan_id": task.get("plan_id") or (task.get("plan") or {}).get("id"),
            "plan_revision": task.get("plan_revision") or (task.get("plan") or {}).get("revision"),
            "plan_item_id": task.get("plan_item_id"),
            "outputs": task.get("outputs", []),
            "execution_status": "registered",
            "delivery_status": "none",
            "delivery_id": None,
            "result_digest": None,
            "observed_turn_id": None,
            "dispatched_at": None,
            "result": None,
            "created_at": int(time.time()),
        }
        record = save_journal(record)
        atomic_write_json(
            registration_ref_path(registration_id),
            {"key": key, "conversation_id": conversation_id, "task_id": task["id"]},
        )

    chain["window_task_count"] = position
    chain["total_task_count"] = sequence
    state["total_task_count"] = sequence
    state["current_task_id"] = task["id"]
    state["current_registration"] = registration_id
    state["phase"] = "task_registered"
    _mark_plan_item_current(state, record)
    _upsert_outputs(state, record, "pending")
    _project_recent_task(state, record)
    return {"registration": "new", "task": _journal_public(record)}


def _maybe_release_stale_registration(state: dict[str, Any]) -> bool:
    if state.get("phase") not in {"task_registered", "result_ready"}:
        return False
    registration_id = state.get("current_registration")
    if not registration_id:
        state["phase"] = "awaiting_assistant"
        return True
    try:
        record = resolve_registration(registration_id)
    except ValueError:
        state["current_registration"] = None
        state["current_task_id"] = None
        state["phase"] = "awaiting_assistant"
        return True
    if record.get("execution_status") != "registered":
        return False
    if int(time.time()) - int(record.get("created_at", 0)) < REGISTRATION_STALE_SECONDS:
        return False
    _release_registration(state, record, "superseded_stale_registration")
    state["phase"] = "awaiting_assistant"
    return True


def _journal_public(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "registration_id": record.get("registration_id"),
        "task_id": record.get("task_id"),
        "title": record.get("title"),
        "sequence": record.get("sequence"),
        "window": record.get("window"),
        "window_position": record.get("window_position"),
        "plan_id": record.get("plan_id"),
        "plan_revision": record.get("plan_revision"),
        "plan_item_id": record.get("plan_item_id"),
        "outputs": record.get("outputs", []),
        "execution_status": record.get("execution_status"),
        "delivery_status": record.get("delivery_status"),
        "delivery_id": record.get("delivery_id"),
        "result_digest": record.get("result_digest"),
        "observed_turn_id": record.get("observed_turn_id"),
        "unknown_acknowledged_at": record.get("unknown_acknowledged_at"),
        # Surfaced so the sidebar can show a completion time on a finished step,
        # as the approved reference does ("Completed - 14:02:11").
        "updated_at": record.get("updated_at"),
    }


def _project_recent_task(state: dict[str, Any], record: dict[str, Any]) -> None:
    """recent_tasks is a bounded DISPLAY projection.

    Nothing may decide staleness, currentness or duplicate-id questions from it;
    those all resolve against the journal, which is never truncated. Keeping this
    list bounded is therefore safe.
    """
    entry = _journal_public(record)
    tasks = [item for item in state.get("recent_tasks", []) if item.get("task_id") != entry["task_id"]]
    tasks.append(entry)
    tasks.sort(key=lambda item: int(item.get("sequence") or 0))
    state["recent_tasks"] = tasks[-MAX_RECENT_TASKS:]


def _plan_item_index(plan: dict[str, Any], item_id: str) -> int | None:
    for index, item in enumerate(plan.get("items", [])):
        if item.get("id") == item_id:
            return index
    return None


def _next_plan_item_id(plan: dict[str, Any]) -> str | None:
    for item in plan.get("items", []):
        if item.get("status", "pending") in {"pending", "current"}:
            return item.get("id")
    return None


def _register_plan_if_needed(state: dict[str, Any], task: dict[str, Any], chain: dict[str, Any]) -> None:
    supplied_plan = task.get("plan")
    existing = state.get("plan")
    plan_item_id = task.get("plan_item_id")
    if supplied_plan is not None:
        if not plan_item_id:
            raise ValueError("task.plan_item_id is required when task.plan is supplied")
        if task.get("plan_id") and task.get("plan_id") != supplied_plan.get("id"):
            raise ValueError("task.plan_id does not match task.plan.id")
        if task.get("plan_revision") is not None and int(task.get("plan_revision")) != int(supplied_plan.get("revision", 0)):
            raise ValueError("task.plan_revision does not match task.plan.revision")
        # A plan is immutable once registered FOR A CHAIN, which is what the
        # protocol document says. A genuine human turn starts a new chain, and
        # that chain may carry its own plan -- without this, the first plan in a
        # conversation permanently blocks every later one: a new plan raises
        # "immutable after execution has begun" and the old plan's items raise
        # "superseded chain", so the plan feature wedges after one use.
        if isinstance(existing, dict) and existing.get("chain_id") != chain.get("chain_id"):
            existing = None
        if isinstance(existing, dict) and existing.get("begun"):
            raise ValueError("plan is immutable after execution has begun")
        if existing is None:
            state["plan"] = {
                **supplied_plan,
                "begun": True,
                "chain_id": chain.get("chain_id"),
                "created_at": int(time.time()),
            }
            existing = state["plan"]

    plan = state.get("plan")
    if not plan_item_id:
        if task.get("plan_id") or task.get("plan_revision") is not None:
            raise ValueError("task.plan_item_id is required when referencing a plan")
        return
    if not isinstance(plan, dict):
        raise ValueError("task references a plan but no plan is registered for this conversation")
    if task.get("plan_id") and task.get("plan_id") != plan.get("id"):
        raise ValueError("task.plan_id does not match the registered plan")
    if task.get("plan_revision") is not None and int(task.get("plan_revision")) != int(plan.get("revision", 0)):
        raise ValueError("task.plan_revision does not match the registered plan")
    if plan.get("chain_id") != chain.get("chain_id"):
        raise ValueError("historical plan item belongs to a superseded chain")

    index = _plan_item_index(plan, plan_item_id)
    if index is None:
        raise ValueError(f"task.plan_item_id {plan_item_id!r} does not exist in the registered plan")
    item = plan["items"][index]
    if item.get("status") in {"completed", "error", "unknown", "skipped"}:
        raise ValueError(f"plan item {plan_item_id!r} has already finished")
    expected = _next_plan_item_id(plan)
    if expected != plan_item_id:
        raise ValueError(f"plan order violation: expected plan item {expected!r}, got {plan_item_id!r}")


def _mark_plan_item_current(state: dict[str, Any], record: dict[str, Any]) -> None:
    plan_item_id = record.get("plan_item_id")
    plan = state.get("plan")
    if not plan_item_id or not isinstance(plan, dict):
        return
    index = _plan_item_index(plan, plan_item_id)
    if index is None:
        return
    for item in plan.get("items", []):
        if item.get("status") == "current" and item.get("id") != plan_item_id:
            item["status"] = "pending"
    item = plan["items"][index]
    item["status"] = "current"
    item["task_id"] = record.get("task_id")
    item["registration_id"] = record.get("registration_id")
    item["sequence"] = record.get("sequence")
    item["window"] = record.get("window")
    item["window_position"] = record.get("window_position")


def _mark_plan_item_from_record(state: dict[str, Any], record: dict[str, Any], status: str) -> None:
    plan_item_id = record.get("plan_item_id")
    plan = state.get("plan")
    if not plan_item_id or not isinstance(plan, dict):
        return
    index = _plan_item_index(plan, plan_item_id)
    if index is None:
        return
    if status not in PLAN_ITEM_STATUSES:
        return
    plan["items"][index]["status"] = status
    if status in {"error", "unknown", "skipped"}:
        plan["items"][index]["finished_reason"] = record.get("abandoned_reason") or record.get("execution_status")


def _upsert_outputs(state: dict[str, Any], record: dict[str, Any], status: str) -> None:
    if status not in OUTPUT_STATUSES:
        return
    declared = record.get("outputs")
    if not isinstance(declared, list):
        return
    existing = {
        item.get("id"): dict(item)
        for item in state.get("outputs", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for output in declared:
        if not isinstance(output, dict):
            continue
        entry = {**output, "status": status, "task_id": record.get("task_id")}
        entry["updated_at"] = int(time.time())
        existing[entry["id"]] = entry
    state["outputs"] = list(existing.values())[-128:]


def _act_task_execution_status(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    record = resolve_registration(payload.get("registration"))
    if record.get("conversation_id") != state["conversation_id"]:
        raise ValueError("registration does not belong to this conversation")
    status = payload.get("status")
    if status not in EXECUTION_STATUSES:
        raise ValueError(f"execution status must be one of {sorted(EXECUTION_STATUSES)}")

    with task_lock(record["key"]):
        record = load_journal(record["key"]) or record
        record["execution_status"] = status
        _ensure_delivery_binding(record)
        record = save_journal(record)

    _project_recent_task(state, record)
    if status == "running":
        _mark_plan_item_from_record(state, record, "current")
    elif status == "completed":
        _mark_plan_item_from_record(state, record, "completed")
        _upsert_outputs(state, record, "produced")
    elif status == "error":
        _mark_plan_item_from_record(state, record, "error")
        _upsert_outputs(state, record, "failed")
    elif status == "unknown":
        _mark_plan_item_from_record(state, record, "unknown")
        _upsert_outputs(state, record, "unknown")
    chain = state.get("active_chain")
    if status == "running":
        state["phase"] = "executing"
        return {}
    if status == "unknown":
        # An ambiguous mutation never waits at a checkpoint and never continues.
        state["phase"] = "stopped"
        state["stopped_reason"] = "unknown_mutation_state"
        return {}
    if status in {"completed", "error"} and isinstance(chain, dict):
        # Delivery still completes when this task fills the current window.
        # Rollover happens after the provider accepts the result turn.
        state["phase"] = "result_ready"
    return {}


def _act_acknowledge_unknown(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Explicitly acknowledge an ambiguous mutation and continue the same chain.

    This does not retry the operation and does not change its execution status.
    The unknown task remains in history and keeps its consumed checkpoint slot.
    """
    if state.get("phase") != "stopped" or state.get("stopped_reason") != "unknown_mutation_state":
        raise ValueError("no unknown mutation is awaiting acknowledgement")

    record = resolve_registration(payload.get("registration"))
    if record.get("conversation_id") != state["conversation_id"]:
        raise ValueError("registration does not belong to this conversation")
    if state.get("current_registration") != record.get("registration_id"):
        raise ValueError("registration is not the current unknown task")

    with task_lock(record["key"]):
        record = load_journal(record["key"]) or record
        if record.get("execution_status") != "unknown":
            raise ValueError("registration is not in unknown execution state")
        record["unknown_acknowledged_at"] = int(time.time())
        record = save_journal(record)

    _project_recent_task(state, record)
    state["current_registration"] = None
    state["current_task_id"] = None
    state["stopped_reason"] = None
    state["phase"] = "awaiting_assistant"
    return {"acknowledged": True}


def _act_task_delivery_status(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    record = resolve_registration(payload.get("registration"))
    if record.get("conversation_id") != state["conversation_id"]:
        raise ValueError("registration does not belong to this conversation")
    status = payload.get("status")
    if status not in DELIVERY_STATUSES:
        raise ValueError(f"delivery status must be one of {sorted(DELIVERY_STATUSES)}")
    if status == "submitted":
        raise ValueError("submitted delivery is recorded only by acknowledge_submission")
    with task_lock(record["key"]):
        record = load_journal(record["key"]) or record
        _ensure_delivery_binding(record)
        record["delivery_status"] = status
        record = save_journal(record)
    _project_recent_task(state, record)
    return {}


def _act_observe_submission(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Record a matching user turn without claiming provider persistence."""
    record = resolve_registration(payload.get("registration"))
    if record.get("conversation_id") != state["conversation_id"]:
        raise ValueError("registration does not belong to this conversation")

    turn_id = payload.get("turn_id")
    if not isinstance(turn_id, str) or not turn_id.strip():
        raise ValueError("observe_submission requires the provider turn_id")
    turn_id = turn_id.strip()[:256]

    with task_lock(record["key"]):
        record = load_journal(record["key"]) or record
        record = _ensure_delivery_binding(record)
        delivery_id = payload.get("delivery_id")
        if not isinstance(delivery_id, str) or not delivery_id.strip():
            raise ValueError("observe_submission requires delivery_id")
        delivery_id = delivery_id.strip()[:128]
        if delivery_id != record.get("delivery_id"):
            raise ValueError("observed delivery_id does not match the pending delivery")
        observed_digest = payload.get("result_digest")
        if observed_digest is not None and observed_digest != record.get("result_digest"):
            raise ValueError("observed result_digest does not match the pending delivery")
        if record.get("delivery_status") == "submitted":
            return {"observed": "known"}
        record["delivery_status"] = "observed"
        record["observed_turn_id"] = turn_id
        record = save_journal(record)

    _project_recent_task(state, record)
    state["last_user_turn_id"] = turn_id
    return {"observed": "new"}


def _act_acknowledge_submission(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Finalize a previously observed result after provider confirmation.

    The browser first records the matching rendered user turn with
    observe_submission. A later provider response confirms that turn was accepted;
    only then may this action mark delivery submitted and advance the checkpoint.
    """
    record = resolve_registration(payload.get("registration"))
    if record.get("conversation_id") != state["conversation_id"]:
        raise ValueError("registration does not belong to this conversation")

    turn_id = payload.get("turn_id")
    if not isinstance(turn_id, str) or not turn_id.strip():
        raise ValueError("acknowledge_submission requires the provider turn_id")
    turn_id = turn_id.strip()[:256]

    with task_lock(record["key"]):
        record = load_journal(record["key"]) or record
        record = _ensure_delivery_binding(record)
        stored = record.get("result")
        if not isinstance(stored, dict):
            raise ValueError("no stored result for this registration")

        delivery_id = payload.get("delivery_id")
        if not isinstance(delivery_id, str) or not delivery_id.strip():
            raise ValueError("acknowledge_submission requires delivery_id")
        delivery_id = delivery_id.strip()[:128]
        if delivery_id != record.get("delivery_id"):
            raise ValueError("submitted delivery_id does not match the pending delivery")

        submitted_digest = payload.get("result_digest")
        if submitted_digest is not None and submitted_digest != record.get("result_digest"):
            raise ValueError("submitted result_digest does not match the pending delivery")

        submitted = payload.get("result")
        if submitted is not None and canonical_json(submitted) != canonical_json(stored):
            raise ValueError("submitted result does not match the stored canonical result")

        if record.get("delivery_status") == "submitted" and record.get("submitted_turn_id") == turn_id:
            save_journal(record)
            return {"acknowledged": "known"}

        if record.get("delivery_status") != "observed":
            raise ValueError("submission must be observed before it can be acknowledged")
        observed_turn_id = record.get("observed_turn_id")
        if not isinstance(observed_turn_id, str) or observed_turn_id != turn_id:
            raise ValueError("acknowledged turn_id does not match the observed submission turn")

        already = False
        record["delivery_status"] = "submitted"
        record["submitted_delivery_id"] = delivery_id
        record["submitted_turn_id"] = turn_id
        record = save_journal(record)

    _project_recent_task(state, record)
    state["last_user_turn_id"] = turn_id
    if already:
        return {"acknowledged": "known"}

    chain = state.get("active_chain")
    if isinstance(chain, dict):
        window_limit = int(chain.get("window_limit", state.get("checkpoint_size", 12)))
        if int(chain.get("window_task_count", 0)) >= window_limit:
            chain["window"] = int(chain.get("window", 0)) + 1
            chain["window_task_count"] = 0
            chain["window_limit"] = int(state.get("checkpoint_size", 12))
            chain["checkpoint_resize_pending"] = False
            # Advancing the approval window invalidates the previous window lease.
            evict_superseded_chain_leases(
                chain.get("approval_scope_id") or chain.get("chain_id"),
                int(chain["window"]),
            )

    if state.get("phase") != "stopped":
        state["phase"] = "awaiting_assistant"
    return {"acknowledged": "new"}


def _release_registration(state: dict[str, Any], record: dict[str, Any], reason: str) -> dict[str, Any]:
    """Release a registered-but-never-dispatched task without refunding history.

    Registration creates the visible history item, so it permanently consumes
    one checkpoint slot regardless of whether it later runs, fails, is denied,
    is abandoned, or reaches an unknown state.
    """
    with task_lock(record["key"]):
        current = load_journal(record["key"]) or record
        if current.get("execution_status") == "registered":
            current["execution_status"] = "error"
            current["abandoned_reason"] = reason
            current = save_journal(current)
            freed = True
        else:
            freed = False
    # A registration is already a history item. Never refund its checkpoint
    # position merely because execution did not dispatch.
    _project_recent_task(state, current)
    _mark_plan_item_from_record(state, current, "skipped")
    _upsert_outputs(state, current, "failed")
    if state.get("current_registration") == current.get("registration_id"):
        state["current_registration"] = None
        state["current_task_id"] = None
    return current


def _act_abandon_task(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """The current task will not run: denied at the approval dialog, or failed
    before dispatch. Without this the chain would sit in task_registered forever
    -- registration refused for phase, continuation refused for having no
    checkpoint. Releasing it returns the chain to a usable state.
    """
    record = resolve_registration(payload.get("registration"))
    if record.get("conversation_id") != state["conversation_id"]:
        raise ValueError("registration does not belong to this conversation")
    reason = payload.get("reason")
    reason = str(reason)[:120] if isinstance(reason, str) and reason.strip() else "abandoned"
    released = _release_registration(state, record, reason)
    if state.get("phase") in {"task_registered", "result_ready"}:
        chain = state.get("active_chain")
        window_limit = int((chain or {}).get("window_limit", state.get("checkpoint_size", 12)))
        if isinstance(chain, dict) and int(chain.get("window_task_count", 0)) >= window_limit:
            chain["window"] = int(chain.get("window", 0)) + 1
            chain["window_task_count"] = 0
            chain["window_limit"] = int(state.get("checkpoint_size", 12))
            chain["checkpoint_resize_pending"] = False
            evict_superseded_chain_leases(
                chain.get("approval_scope_id") or chain.get("chain_id"),
                int(chain["window"]),
            )
        state["phase"] = "awaiting_assistant"
    return {"abandoned": released.get("execution_status")}


CONVERSATION_ACTIONS.update({
    "register_task": _act_register_task,
    "abandon_task": _act_abandon_task,
    "task_execution_status": _act_task_execution_status,
    "task_delivery_status": _act_task_delivery_status,
    "observe_submission": _act_observe_submission,
    "acknowledge_submission": _act_acknowledge_submission,
    "acknowledge_unknown": _act_acknowledge_unknown,
})


def registry_version(servers: dict[str, dict[str, Any]] | None = None) -> str:
    snapshot = servers if servers is not None else servers_snapshot()
    return hashlib.sha256(canonical_json(snapshot).encode("utf-8")).hexdigest()


ensure_state_permissions()
TOKEN = load_token()
SERVERS = load_servers()
SERVERS_LOCK = threading.RLock()
TOOL_CATALOG_GUARD = threading.RLock()
TOOL_CATALOG_FINGERPRINTS: dict[str, str] = {}
TASK_LOCKS_GUARD = threading.RLock()
TASK_LOCKS: dict[str, threading.RLock] = {}
CONVERSATION_LOCKS_GUARD = threading.RLock()
CONVERSATION_LOCKS: dict[str, threading.RLock] = {}
MCP_POOL_LOCK = threading.RLock()
MCP_POOL: dict[str, tuple[str, "McpHttpClient"]] = {}
APPROVAL_LOCK = threading.RLock()
# Approval state is intentionally ephemeral. Daemon restart or browser-tab session change clears trust.
SESSION_LEASES: dict[tuple[str, str], dict[str, Any]] = {}
CHAIN_LEASES: dict[tuple[str, str, str], dict[str, Any]] = {}
ONCE_APPROVALS: dict[str, dict[str, Any]] = {}
SERVER_RW_LOCKS_GUARD = threading.RLock()
SERVER_RW_LOCKS: dict[str, "ReadWriteLock"] = {}


class ReadWriteLock:
    """Writer-preferring RW lock used as an execution barrier per MCP server.

    Read-only and verification operations share the observation side. Write and
    destructive operations take the exclusive side. The MCP transport may still
    serialize requests internally; this lock's job is the policy/state barrier.
    """

    def __init__(self) -> None:
        self._condition = threading.Condition(threading.RLock())
        self._readers = 0
        self._writer = False
        self._waiting_writers = 0

    @contextmanager
    def read(self):
        with self._condition:
            while self._writer or self._waiting_writers:
                self._condition.wait()
            self._readers += 1
        try:
            yield
        finally:
            with self._condition:
                self._readers -= 1
                if self._readers == 0:
                    self._condition.notify_all()

    @contextmanager
    def write(self):
        with self._condition:
            self._waiting_writers += 1
            try:
                while self._writer or self._readers:
                    self._condition.wait()
                self._writer = True
            finally:
                self._waiting_writers -= 1
        try:
            yield
        finally:
            with self._condition:
                self._writer = False
                self._condition.notify_all()


def server_rw_lock(server: str) -> ReadWriteLock:
    with SERVER_RW_LOCKS_GUARD:
        lock = SERVER_RW_LOCKS.get(server)
        if lock is None:
            lock = ReadWriteLock()
            SERVER_RW_LOCKS[server] = lock
        return lock


def servers_snapshot() -> dict[str, dict[str, Any]]:
    with SERVERS_LOCK:
        return {name: dict(cfg) for name, cfg in SERVERS.items()}


def connection_fingerprint(cfg: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json({
        "transport": cfg.get("transport"),
        "endpoint": cfg.get("endpoint"),
        "timeout_s": cfg.get("timeout_s"),
        "enabled": cfg.get("enabled"),
    }).encode("utf-8")).hexdigest()


def save_servers(raw: Any, expected_version: Any) -> tuple[dict[str, dict[str, Any]], str]:
    validated = validate_servers_payload(raw)
    with SERVERS_LOCK:
        current_version = registry_version(SERVERS)
        if not isinstance(expected_version, str) or expected_version != current_version:
            raise ValueError(
                f"server_registry_changed: expected version {expected_version!r}, current {current_version}; reload settings"
            )
        atomic_write_json(SERVERS_FILE, validated)
        SERVERS.clear()
        SERVERS.update(validated)
        new_version = registry_version(SERVERS)
    close_all_mcp_clients()
    return servers_snapshot(), new_version


def head_clip(text: str, limit: int = MAX_RESULT_STRING) -> tuple[str, bool]:
    data = text.encode("utf-8", errors="replace")
    if len(data) <= limit:
        return text, False
    head = data[:limit].decode("utf-8", errors="replace")
    return f"{head}\n[truncated after {limit} bytes]", True


def clip_mcp_value(value: Any) -> tuple[Any, bool]:
    if isinstance(value, str):
        return head_clip(value)
    if isinstance(value, list):
        out = []
        truncated = False
        for item in value:
            clipped, item_truncated = clip_mcp_value(item)
            out.append(clipped)
            truncated = truncated or item_truncated
        return out, truncated
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        truncated = False
        for key, item in value.items():
            clipped, item_truncated = clip_mcp_value(item)
            out[str(key)] = clipped
            truncated = truncated or item_truncated
        return out, truncated
    return value, False


def parse_sse_json(body: bytes, expected_id: int | str) -> dict[str, Any]:
    text = body.decode("utf-8", errors="replace")
    data_lines: list[str] = []
    candidates: list[dict[str, Any]] = []

    def flush() -> None:
        nonlocal data_lines
        if not data_lines:
            return
        raw = "\n".join(data_lines)
        data_lines = []
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            return
        if isinstance(value, dict):
            candidates.append(value)

    for line in text.splitlines():
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line.strip():
            flush()
    flush()

    for candidate in candidates:
        if candidate.get("id") == expected_id:
            return candidate
    clipped, _ = head_clip(text, 4000)
    raise ValueError(f"MCP SSE response contained no response for id {expected_id!r}: {clipped}")


class McpHttpClient:
    """Small MCP Streamable HTTP client. Policy is enforced above this layer."""

    def __init__(self, name: str, config: dict[str, Any]):
        self.name = name
        self.config = dict(config)
        self.endpoint = str(config["endpoint"])
        self.parsed = ensure_loopback_http(self.endpoint)
        self.timeout = int(config.get("timeout_s", 30))
        self.session_id: str | None = None
        self.request_id = 0
        self.initialized = False
        self.initialize_result: dict[str, Any] | None = None
        self.protocol_version: str | None = None
        self.catalog: dict[str, dict[str, Any]] | None = None
        self.last_used = time.time()
        self.lock = threading.RLock()

    def _path(self) -> str:
        path = self.parsed.path or "/"
        if self.parsed.query:
            path += "?" + self.parsed.query
        return path

    def _headers(self, *, include_protocol: bool) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/event-stream",
            "User-Agent": f"LocalMcpBridge/{VERSION}",
        }
        if include_protocol and self.protocol_version:
            headers["MCP-Protocol-Version"] = self.protocol_version
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        return headers

    def _post(
        self,
        message: dict[str, Any],
        *,
        expected_id: int | str | None,
        expect_body: bool = True,
        include_protocol: bool = True,
    ) -> dict[str, Any] | None:
        body = json_bytes(message)
        headers = self._headers(include_protocol=include_protocol)
        headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection(self.parsed.hostname, self.parsed.port, timeout=self.timeout)
        # Whether the request actually reached the server decides whether a failed
        # mutating call is a clean 'error' or an ambiguous 'unknown'. Only a
        # failure to establish the connection is provably pre-dispatch; anything
        # from the write onward is treated as dispatched.
        dispatched = False
        try:
            try:
                conn.request("POST", self._path(), body=body, headers=headers)
            except (ConnectionRefusedError, socket.gaierror):
                raise
            except Exception:
                dispatched = True
                raise
            dispatched = True
            response = conn.getresponse()
            raw = response.read(MAX_MCP_BODY + 1)
            if len(raw) > MAX_MCP_BODY:
                raise ValueError(f"MCP response exceeded {MAX_MCP_BODY} bytes")
            if response.status < 200 or response.status >= 300:
                text, _ = head_clip(raw.decode("utf-8", errors="replace"), 4000)
                raise McpHttpError(response.status, f"MCP {self.name} HTTP {response.status}: {text}")
            session = response.getheader("Mcp-Session-Id") or response.getheader("MCP-Session-Id")
            if session:
                self.session_id = session
            if not raw:
                if expect_body:
                    raise ValueError(f"MCP {self.name} returned an empty response")
                return None
            if expected_id is None:
                return None
            content_type = (response.getheader("Content-Type") or "").lower()
            if "text/event-stream" in content_type:
                return parse_sse_json(raw, expected_id)
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError(f"MCP {self.name} returned a non-object JSON response")
            return payload
        except Exception as exc:
            setattr(exc, "lbp_dispatched", dispatched)
            raise
        finally:
            conn.close()
            self.last_used = time.time()

    def _next_id(self) -> int:
        self.request_id += 1
        return self.request_id

    @staticmethod
    def _validate_response(payload: dict[str, Any] | None, request_id: int, method: str) -> dict[str, Any]:
        if payload is None:
            raise ValueError(f"MCP {method} returned no response")
        if payload.get("id") != request_id:
            raise ValueError(f"MCP {method} response id mismatch: expected {request_id}, got {payload.get('id')!r}")
        if "error" in payload:
            raise ValueError(f"MCP {method} error: {json.dumps(payload['error'], ensure_ascii=False)}")
        result = payload.get("result")
        if not isinstance(result, dict):
            raise ValueError(f"MCP {method} response has no object result")
        return result

    def reset_session(self) -> None:
        self.session_id = None
        self.initialized = False
        self.initialize_result = None
        self.protocol_version = None
        self.catalog = None

    def initialize(self) -> None:
        if self.initialized:
            return
        request_id = self._next_id()
        payload = self._post({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_REQUESTED_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "local-mcp-bridge", "version": VERSION},
            },
        }, expected_id=request_id, include_protocol=False)
        result = self._validate_response(payload, request_id, "initialize")
        negotiated = result.get("protocolVersion")
        if not isinstance(negotiated, str) or not negotiated:
            raise ValueError(f"MCP {self.name} initialize did not return protocolVersion")
        self.initialize_result = result
        self.protocol_version = negotiated
        self._post({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {},
        }, expected_id=None, expect_body=False, include_protocol=True)
        self.initialized = True

    def _rpc_once(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        request_id = self._next_id()
        payload = self._post({
            "jsonrpc": "2.0", "id": request_id, "method": method, "params": params,
        }, expected_id=request_id, include_protocol=True)
        return self._validate_response(payload, request_id, method)

    def _rpc(self, method: str, params: dict[str, Any], *, allow_session_retry: bool = True) -> dict[str, Any]:
        try:
            return self._rpc_once(method, params)
        except McpHttpError as exc:
            if exc.status != 404 or not self.session_id:
                raise
            if not allow_session_retry:
                # The request reached the server before it answered 404. A server
                # that expired the session AFTER applying a mutation would get the
                # mutation applied twice. Never silently re-dispatch a mutating
                # call; surface it as ambiguous instead.
                self.reset_session()
                raise
            self.reset_session()
            return self._rpc_once(method, params)

    def call_tool(
        self,
        tool: str,
        arguments: dict[str, Any],
        *,
        allow_session_retry: bool = True,
    ) -> dict[str, Any]:
        with self.lock:
            return self._rpc(
                "tools/call",
                {"name": tool, "arguments": arguments},
                allow_session_retry=allow_session_retry,
            )

    def list_tools(self, *, refresh: bool = False) -> dict[str, Any]:
        with self.lock:
            if self.catalog is not None and not refresh:
                return {"tools": list(self.catalog.values())}
            result = self._rpc("tools/list", {})
            tools = result.get("tools", [])
            if not isinstance(tools, list):
                raise ValueError(f"MCP {self.name} tools/list returned invalid tools")
            catalog: dict[str, dict[str, Any]] = {}
            for tool in tools:
                if isinstance(tool, dict) and isinstance(tool.get("name"), str):
                    catalog[tool["name"]] = tool
            self.catalog = catalog
            return {"tools": list(catalog.values())}

    def server_info(self) -> dict[str, Any]:
        with self.lock:
            self.initialize()
            result = self.initialize_result or {}
            info = result.get("serverInfo", {})
            return info if isinstance(info, dict) else {}

    def close(self) -> None:
        with self.lock:
            if not self.session_id:
                return
            conn = http.client.HTTPConnection(self.parsed.hostname, self.parsed.port, timeout=min(self.timeout, 5))
            try:
                conn.request("DELETE", self._path(), headers=self._headers(include_protocol=True))
                response = conn.getresponse()
                response.read(4096)
            except Exception:
                pass
            finally:
                conn.close()
                self.reset_session()


def close_all_mcp_clients() -> None:
    with MCP_POOL_LOCK:
        entries = list(MCP_POOL.values())
        MCP_POOL.clear()
    for _, client in entries:
        client.close()


atexit.register(close_all_mcp_clients)


def get_server_config(server: str) -> dict[str, Any]:
    with SERVERS_LOCK:
        cfg = dict(SERVERS.get(server, {}))
        known = sorted(SERVERS)
    if not cfg:
        raise ValueError(f"unknown MCP server {server!r}; known: {known}")
    if not cfg.get("enabled", True):
        raise ValueError(f"MCP server {server!r} is disabled")
    return cfg


def get_mcp_client(server: str) -> McpHttpClient:
    cfg = get_server_config(server)
    fingerprint = connection_fingerprint(cfg)
    with MCP_POOL_LOCK:
        entry = MCP_POOL.get(server)
        if entry:
            old_fingerprint, client = entry
            if old_fingerprint != fingerprint or time.time() - client.last_used > MCP_CLIENT_IDLE_SECONDS:
                client.close()
                MCP_POOL.pop(server, None)
                entry = None
        if not entry:
            client = McpHttpClient(server, cfg)
            MCP_POOL[server] = (fingerprint, client)
        else:
            client = entry[1]
    return client


def tool_classification(tool: dict[str, Any]) -> str:
    annotations = tool.get("annotations")
    if not isinstance(annotations, dict):
        annotations = {}
    if annotations.get("destructiveHint") is True:
        return "destructive"
    if annotations.get("readOnlyHint") is True:
        return "read_only"
    return "write"


def command_argv(value: Any) -> list[str] | None:
    if isinstance(value, list) and value and all(isinstance(part, str) and part for part in value):
        return list(value)
    if not isinstance(value, str) or not value.strip():
        return None
    # Verification rules are deliberately not a shell-policy language. Shell control
    # operators, substitution and redirection fail closed before tokenization.
    if any(ch in SHELL_META_CHARS for ch in value):
        return None
    try:
        argv = shlex.split(value, posix=True)
    except ValueError:
        return None
    return argv or None


def verification_match(tool_name: str, arguments: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any] | None:
    if not cfg.get("allow_verify", False):
        return None
    for rule in cfg.get("verification_rules", []):
        if rule.get("tool") != tool_name:
            continue
        argument = rule.get("argument", "command")
        cwd_argument = rule.get("cwd_argument", "cwd")
        cwd_raw = arguments.get(cwd_argument)
        if not isinstance(cwd_raw, str) or not cwd_raw.strip():
            continue
        cwd = pathlib.Path(cwd_raw).expanduser()
        if not cwd.is_absolute():
            continue
        argv = command_argv(arguments.get(argument))
        if not argv:
            continue
        for prefix in rule.get("argv_prefixes", []):
            if len(argv) >= len(prefix) and argv[:len(prefix)] == prefix:
                return {
                    "argument": argument,
                    "cwd_argument": cwd_argument,
                    "cwd": str(cwd),
                    "argv": argv,
                    "matched_prefix": prefix,
                }
    return None


def effective_classification(
    tool: dict[str, Any],
    tool_name: str,
    arguments: dict[str, Any],
    cfg: dict[str, Any],
) -> tuple[str, dict[str, Any] | None]:
    base = tool_classification(tool)
    # Generic command runners may be conservatively classified as destructive by
    # their MCP server. A narrower daemon-owned rule may still authorize an exact
    # command family as VERIFY. The model cannot request this downgrade itself.
    verification = verification_match(tool_name, arguments, cfg) if base in {"write", "destructive"} else None
    if verification:
        return "verify", verification
    return base, None


def compact_tool(tool: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": tool.get("name"),
        "description": tool.get("description") if isinstance(tool.get("description"), str) else None,
        "classification": tool_classification(tool),
    }


def test_server_connection(name: str, config: dict[str, Any]) -> dict[str, Any]:
    cfg = validate_server_config(name, config)
    client = McpHttpClient(name, cfg)
    started = time.time()
    try:
        tools_result = client.list_tools(refresh=True)
        tools = [compact_tool(tool) for tool in tools_result.get("tools", []) if isinstance(tool, dict)]
        return {
            "server": name,
            "endpoint": cfg["endpoint"],
            "connected": True,
            "tool_count": len(tools),
            "tools": tools,
            "server_info": client.server_info(),
            "protocol_version": client.protocol_version,
            "duration_ms": int((time.time() - started) * 1000),
        }
    finally:
        client.close()


FREEFORM_TEXT_KEYS = {
    "content",
    "old",
    "new",
    "patch",
    "text",
    "replacement",
    "pattern",
    "query",
}


def is_path_key(key: str) -> bool:
    lower = key.lower()
    return lower in PATH_KEYS or lower.endswith("_path") or lower.endswith("_dir")


def is_freeform_text_key(key: str) -> bool:
    return key.lower() in FREEFORM_TEXT_KEYS


def is_traversal_shaped(value: str) -> bool:
    """A relative value that is trying to reach outside a working directory.

    Explicit path keys already fail closed on any relative value. This covers the
    other half: a tool whose path argument is named something the key heuristic
    does not recognize -- `file`, `filename`, `target`, `dest`, `output` -- where
    only absolute values used to be checked, so `../../../.ssh/id_rsa` escaped
    the root boundary entirely.

    Deliberately narrow: it matches traversal and explicit relative-path shapes,
    not every string that happens to contain a slash, so ordinary values like
    "feature/x" or "hello/world" are unaffected.
    """
    text = value.strip()
    if not text:
        return False
    if text.startswith(("./", "../", "~/", "~\\", ".\\", "..\\")):
        return True
    parts = text.replace("\\", "/").split("/")
    return any(part == ".." for part in parts)


def values_from_path_field(value: Any) -> Iterable[str]:
    if isinstance(value, str) and value.strip():
        yield value
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item.strip():
                yield item


def collect_path_arguments(
    value: Any,
    prefix: str = "",
    path_key_context: bool = False,
    detect_path_by_value: bool = True,
) -> list[tuple[str, str]]:
    """Collect policy-relevant local paths without treating source/text payloads as paths.

    Explicit path keys remain authoritative, including relative values that must fail
    closed. Unknown fields still receive value-based absolute-path detection so an MCP
    server cannot bypass root policy merely by renaming a path argument. Known
    free-form payload fields such as content/old/new/patch/pattern are exempt from
    value-only detection because their source text may legitimately begin with '/'.
    """
    found: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key)
            location = f"{prefix}.{key_text}" if prefix else key_text
            child_path_context = path_key_context or is_path_key(key_text)
            child_value_detection = detect_path_by_value and not is_freeform_text_key(key_text)
            found.extend(
                collect_path_arguments(
                    child,
                    location,
                    child_path_context,
                    child_value_detection,
                )
            )
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(
                collect_path_arguments(
                    child,
                    f"{prefix}[{index}]",
                    path_key_context,
                    detect_path_by_value,
                )
            )
    elif isinstance(value, str) and value.strip():
        raw = value.strip()
        expanded = pathlib.Path(raw).expanduser()
        if path_key_context:
            found.append((prefix or "<argument>", raw))
        elif detect_path_by_value and (expanded.is_absolute() or is_traversal_shaped(raw)):
            found.append((prefix or "<argument>", raw))
    return found


def check_path_policy(arguments: dict[str, Any], cfg: dict[str, Any]) -> list[dict[str, str]]:
    found = collect_path_arguments(arguments)
    if not found:
        return []
    roots = [pathlib.Path(root).expanduser().resolve(strict=False) for root in cfg.get("roots", [])]
    if not roots:
        raise ValueError("path_policy_denied: tool arguments contain local paths but this server has no allowed roots")
    checks: list[dict[str, str]] = []
    for field, raw in found:
        path = pathlib.Path(raw).expanduser()
        if not path.is_absolute():
            raise ValueError(f"path_policy_denied: {field} must be an absolute path, got {raw!r}")
        resolved = path.resolve(strict=False)
        matching = None
        for root in roots:
            try:
                resolved.relative_to(root)
                matching = root
                break
            except ValueError:
                pass
        if matching is None:
            raise ValueError(f"path_policy_denied: {field} resolves outside configured roots: {resolved}")
        checks.append({"field": field, "path": str(resolved), "root": str(matching)})
    return checks


def verification_argv_path_checks(verification: dict[str, Any], cfg: dict[str, Any]) -> list[dict[str, str]]:
    """Contain explicit path-like argv tokens under configured roots.

    VERIFY is not a process sandbox, but command-line path escapes should not bypass
    the same local-root boundary merely because the path is embedded inside a command
    string instead of a dedicated MCP argument field.
    """
    roots = [pathlib.Path(root).expanduser().resolve(strict=False) for root in cfg.get("roots", [])]
    if not roots:
        raise ValueError("path_policy_denied: VERIFY requires at least one allowed root")
    cwd = pathlib.Path(str(verification["cwd"])).expanduser().resolve(strict=False)
    checks: list[dict[str, str]] = []
    for index, token in enumerate(verification.get("argv", [])):
        candidate = token
        if token.startswith("-") and "=" in token:
            candidate = token.split("=", 1)[1]
        if not candidate or "://" in candidate:
            continue
        looks_path_like = (
            candidate.startswith(("/", "~/", "./", "../"))
            or "/" in candidate
        )
        if not looks_path_like:
            continue
        path = pathlib.Path(candidate).expanduser()
        if not path.is_absolute():
            path = cwd / path
        resolved = path.resolve(strict=False)
        matching = None
        for root in roots:
            try:
                resolved.relative_to(root)
                matching = root
                break
            except ValueError:
                pass
        if matching is None:
            raise ValueError(
                f"path_policy_denied: verification argv[{index}] resolves outside configured roots: {resolved}"
            )
        checks.append({
            "field": f"verification.argv[{index}]",
            "path": str(resolved),
            "root": str(matching),
        })
    return checks


def validate_browser_session_id(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError("browser session id must be a non-empty string")
    value = value.strip()
    if len(value) > 128 or any(not (ch.isalnum() or ch in "._-") for ch in value):
        raise ValueError("browser session id contains invalid characters")
    return value


def policy_fingerprint(server: str, cfg: dict[str, Any]) -> str:
    """Bind an approval to the policy AND to the tool classifications it assumed.

    Classification is derived from annotations the MCP server publishes, and the
    catalog is re-fetched at preflight. Without the catalog in the fingerprint, a
    server that relabels a tool from destructive to read-only between grant and
    use would not invalidate a live lease.
    """
    material = {
        "server": server,
        "config": cfg,
        "catalog": TOOL_CATALOG_FINGERPRINTS.get(server),
    }
    return hashlib.sha256(canonical_json(material).encode("utf-8")).hexdigest()


def cleanup_approval_state() -> None:
    now = time.time()
    with APPROVAL_LOCK:
        for key, lease in list(SESSION_LEASES.items()):
            if lease.get("expires_at", 0) <= now:
                SESSION_LEASES.pop(key, None)
        for key, lease in list(CHAIN_LEASES.items()):
            if lease.get("expires_at", 0) <= now:
                CHAIN_LEASES.pop(key, None)
        for token, approval in list(ONCE_APPROVALS.items()):
            if approval.get("expires_at", 0) <= now:
                ONCE_APPROVALS.pop(token, None)


def session_lease_covers(
    conversation_id: str | None,
    server: str,
    classification: str,
    cfg: dict[str, Any],
) -> bool:
    """Session leases are bound to (conversation_id, server).

    They are deliberately NOT keyed on the browser session id: a lease must not
    follow the user from one conversation into another, and the browser must not
    be able to widen a lease's reach by choosing its own session identifier.
    """
    if not conversation_id:
        return False
    cleanup_approval_state()
    with APPROVAL_LOCK:
        lease = SESSION_LEASES.get((conversation_id, server))
        if not lease:
            return False
        if lease.get("policy_fingerprint") != policy_fingerprint(server, cfg):
            SESSION_LEASES.pop((conversation_id, server), None)
            return False
        return int(lease.get("max_risk", -1)) >= RISK_RANK.get(classification, 99)


def chain_lease_covers(
    conversation_id: str | None,
    window_id: str | None,
    server: str,
    classification: str,
    cfg: dict[str, Any],
) -> bool:
    """Checkpoint approval covers the current checkpoint window and nothing wider.

    window_id is derived by the daemon from a conversation checkpoint scope plus
    its window number and is never accepted from the browser. Human follow-up
    turns keep that scope; advancing the checkpoint necessarily creates a fresh
    approval window.
    """
    if not conversation_id or not window_id:
        return False
    cleanup_approval_state()
    key = (conversation_id, window_id, server)
    with APPROVAL_LOCK:
        lease = CHAIN_LEASES.get(key)
        if not lease:
            return False
        if lease.get("policy_fingerprint") != policy_fingerprint(server, cfg):
            CHAIN_LEASES.pop(key, None)
            return False
        return int(lease.get("max_risk", -1)) >= RISK_RANK.get(classification, 99)


def approval_decision(
    server: str,
    classification: str,
    cfg: dict[str, Any],
    conversation_id: str | None,
    window_id: str | None = None,
) -> dict[str, Any]:
    mode = cfg.get("approval_mode", "mutations")
    escalation = cfg.get("approval_escalation", "chain")

    # The independent destructive gate is stronger than any temporary lease.
    if classification == "destructive" and cfg.get("always_approve_destructive", True):
        return {
            "required": True,
            "reason": "destructive_always",
            "mode": mode,
            "approval_escalation": escalation,
            "chain_approval_available": False,
            "session_approval_available": False,
        }

    if session_lease_covers(conversation_id, server, classification, cfg):
        return {
            "required": False,
            "reason": "session_lease",
            "mode": mode,
            "approval_escalation": escalation,
            "chain_approval_available": False,
            "session_approval_available": False,
        }

    if chain_lease_covers(conversation_id, window_id, server, classification, cfg):
        return {
            "required": False,
            "reason": "chain_lease",
            "mode": mode,
            "approval_escalation": escalation,
            "chain_approval_available": False,
            "session_approval_available": False,
        }

    chain_available = bool(conversation_id and window_id and escalation in {"chain", "session"})
    session_available = bool(conversation_id and (mode == "session" or escalation == "session"))

    if mode == "none":
        return {
            "required": False,
            "reason": "policy_auto",
            "mode": mode,
            "approval_escalation": escalation,
            "chain_approval_available": False,
            "session_approval_available": False,
        }
    if mode == "mutations":
        required = classification in {"write", "destructive"}
        auto_reason = "verify_auto" if classification == "verify" else "read_auto"
        return {
            "required": required,
            "reason": "mutation" if required else auto_reason,
            "mode": mode,
            "approval_escalation": escalation,
            "chain_approval_available": required and chain_available,
            "session_approval_available": required and session_available,
            "session_ttl_seconds": SESSION_LEASE_TTL_SECONDS if required and session_available else None,
        }
    if mode == "all":
        return {
            "required": True,
            "reason": "all_operations",
            "mode": mode,
            "approval_escalation": escalation,
            "chain_approval_available": chain_available,
            "session_approval_available": session_available,
            "session_ttl_seconds": SESSION_LEASE_TTL_SECONDS if session_available else None,
        }
    if mode == "session":
        return {
            "required": True,
            "reason": "session_required",
            "mode": mode,
            "approval_escalation": escalation,
            "chain_approval_available": chain_available,
            "session_approval_available": session_available,
            "session_ttl_seconds": SESSION_LEASE_TTL_SECONDS,
        }
    raise ValueError(f"invalid approval mode {mode!r}")


def task_digest(task: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(task).encode("utf-8")).hexdigest()


def result_digest(result: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(result).encode("utf-8")).hexdigest()


def make_delivery_id() -> str:
    return f"d-{secrets.token_hex(16)}"


def _ensure_delivery_binding(record: dict[str, Any]) -> dict[str, Any]:
    result = record.get("result")
    if not isinstance(result, dict):
        return record
    digest = result_digest(result)
    if record.get("result_digest") != digest:
        record["result_digest"] = digest
        record["delivery_id"] = make_delivery_id()
    elif not isinstance(record.get("delivery_id"), str) or not record["delivery_id"].strip():
        record["delivery_id"] = make_delivery_id()
    return record


def grant_approval(
    raw_task: Any,
    session_id: str | None,
    decision: str,
    window_id: str | None = None,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    session_id = validate_browser_session_id(session_id)
    task, preview = preflight_task(raw_task, session_id, window_id, conversation_id)
    approval = preview["approval"]
    if not approval.get("required"):
        return {
            "approval_required": False,
            "approval_token": None,
            "chain_granted": False,
            "session_granted": False,
        }
    if decision not in {"once", "chain", "session"}:
        raise ValueError("approval decision must be 'once', 'chain', or 'session'")
    if decision == "chain" and not approval.get("chain_approval_available"):
        raise ValueError("chain approval is not available for this operation under current policy")
    if decision == "session" and not approval.get("session_approval_available"):
        raise ValueError("session approval is not available for this operation under current policy")

    op = preview["operation"]
    server = op["server"]
    cfg = get_server_config(server)

    if decision == "chain":
        assert conversation_id is not None and window_id is not None
        with APPROVAL_LOCK:
            CHAIN_LEASES[(conversation_id, window_id, server)] = {
                "max_risk": RISK_RANK[op["classification"]],
                "policy_fingerprint": policy_fingerprint(server, cfg),
                "expires_at": time.time() + SESSION_LEASE_TTL_SECONDS,
            }

    if decision == "session":
        assert conversation_id is not None
        with APPROVAL_LOCK:
            SESSION_LEASES[(conversation_id, server)] = {
                "max_risk": RISK_RANK[op["classification"]],
                "policy_fingerprint": policy_fingerprint(server, cfg),
                "expires_at": time.time() + SESSION_LEASE_TTL_SECONDS,
            }

    token: str | None = None
    if decision == "once":
        token = secrets.token_urlsafe(24)
        with APPROVAL_LOCK:
            ONCE_APPROVALS[token] = {
                "task_digest": task_digest(task),
                "session_id": session_id,
                "policy_fingerprint": policy_fingerprint(server, cfg),
                "classification": op["classification"],
                "expires_at": time.time() + APPROVAL_TOKEN_TTL_SECONDS,
            }
    return {
        "approval_required": True,
        "approval_token": token,
        "chain_granted": decision == "chain",
        "chain_expires_in_s": SESSION_LEASE_TTL_SECONDS if decision == "chain" else None,
        "session_granted": decision == "session",
        "session_expires_in_s": SESSION_LEASE_TTL_SECONDS if decision == "session" else None,
    }


def authorize_execution(
    task: dict[str, Any],
    preview: dict[str, Any],
    session_id: str | None,
    approval_token: str | None,
) -> None:
    approval = preview["approval"]
    if not approval.get("required"):
        return
    if not approval_token or not isinstance(approval_token, str):
        raise ValueError("approval_required: local approval is required before execution")
    cleanup_approval_state()
    op = preview["operation"]
    cfg = get_server_config(op["server"])
    with APPROVAL_LOCK:
        entry = ONCE_APPROVALS.get(approval_token)
        if not entry:
            raise ValueError("approval_required: approval token is missing, expired, or already used")
        if entry.get("task_digest") != task_digest(task):
            raise ValueError("approval_required: approval token does not match this task")
        if entry.get("session_id") != session_id:
            raise ValueError("approval_required: approval token does not match this browser session")
        if entry.get("policy_fingerprint") != policy_fingerprint(op["server"], cfg):
            ONCE_APPROVALS.pop(approval_token, None)
            raise ValueError("approval_required: local policy changed after approval; preview again")
        if entry.get("classification") != op.get("classification"):
            ONCE_APPROVALS.pop(approval_token, None)
            raise ValueError("approval_required: tool classification changed after approval; preview again")
        # Consume only after task/session binding checks pass. A bad replay must not
        # burn the user's legitimate one-time approval token; a policy/classification
        # change intentionally invalidates it.
        ONCE_APPROVALS.pop(approval_token, None)


def validate_task_text(value: Any, field: str, max_len: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"task.{field} must be a string")
    if len(value) > max_len:
        raise ValueError(f"task.{field} exceeds {max_len} characters")
    return value


def validate_metadata_id(value: Any, field: str, max_len: int = 128) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    value = value.strip()
    if len(value) > max_len:
        raise ValueError(f"{field} must be <= {max_len} characters")
    return value


def normalize_plan_context(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {"resources": [], "constraints": []}
    if not isinstance(raw, dict):
        raise ValueError("plan.context must be a JSON object")
    resources_raw = raw.get("resources", [])
    constraints_raw = raw.get("constraints", [])
    if not isinstance(resources_raw, list) or len(resources_raw) > 64:
        raise ValueError("plan.context.resources must be an array with at most 64 items")
    if not isinstance(constraints_raw, list) or len(constraints_raw) > 64:
        raise ValueError("plan.context.constraints must be an array with at most 64 items")
    resources: list[dict[str, str]] = []
    for index, item in enumerate(resources_raw):
        if not isinstance(item, dict):
            raise ValueError(f"plan.context.resources[{index}] must be an object")
        kind = validate_metadata_id(item.get("kind", "resource"), f"plan.context.resources[{index}].kind", 48)
        label = validate_metadata_id(item.get("label"), f"plan.context.resources[{index}].label", 200)
        resource = {"kind": kind, "label": label}
        ref = item.get("ref")
        if isinstance(ref, str) and ref.strip():
            resource["ref"] = ref.strip()[:1000]
        resources.append(resource)
    constraints = [
        item.strip()[:300]
        for item in constraints_raw
        if isinstance(item, str) and item.strip()
    ]
    if len(constraints) != len(constraints_raw):
        raise ValueError("plan.context.constraints must contain only non-empty strings")
    return {"resources": resources, "constraints": constraints}


def normalize_plan(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("task.plan must be a JSON object")
    plan_id = validate_metadata_id(raw.get("id"), "plan.id")
    try:
        revision = int(raw.get("revision"))
    except (TypeError, ValueError) as exc:
        raise ValueError("plan.revision must be an integer") from exc
    if revision < 1:
        raise ValueError("plan.revision must be >= 1")
    title = validate_task_text(raw.get("title"), "plan.title", 200)
    items_raw = raw.get("items")
    if not isinstance(items_raw, list) or not items_raw or len(items_raw) > 100:
        raise ValueError("plan.items must contain 1..100 items")
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(items_raw):
        if not isinstance(item, dict):
            raise ValueError(f"plan.items[{index}] must be an object")
        item_id = validate_metadata_id(item.get("id"), f"plan.items[{index}].id")
        if item_id in seen:
            raise ValueError(f"plan item id {item_id!r} is not unique")
        seen.add(item_id)
        phase = validate_task_text(item.get("phase"), f"plan.items[{index}].phase", 80) or "execute"
        item_title = validate_task_text(item.get("title"), f"plan.items[{index}].title", 200)
        if not item_title:
            raise ValueError(f"plan.items[{index}].title must be a non-empty string")
        items.append({
            "id": item_id,
            "phase": phase,
            "title": item_title,
            "status": "pending",
        })
    return {
        "id": plan_id,
        "revision": revision,
        "title": title or plan_id,
        "items": items,
        "context": normalize_plan_context(raw.get("context")),
    }


def normalize_outputs(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 64:
        raise ValueError("task.outputs must be an array with at most 64 items")
    outputs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"task.outputs[{index}] must be an object")
        output_id = validate_metadata_id(item.get("id"), f"task.outputs[{index}].id")
        if output_id in seen:
            raise ValueError(f"task.outputs id {output_id!r} is not unique")
        seen.add(output_id)
        label = validate_metadata_id(item.get("label"), f"task.outputs[{index}].label", 200)
        kind = validate_metadata_id(item.get("kind"), f"task.outputs[{index}].kind", 80)
        output = {"id": output_id, "label": label, "kind": kind}
        ref = item.get("ref")
        if isinstance(ref, str) and ref.strip():
            output["ref"] = ref.strip()[:1000]
        outputs.append(output)
    return outputs


MAX_MUTATE_CALLS = 8
SUPPORTED_LBP_TASK_VERSIONS = {"1.2", "1.3", "1.3.1"}


def has_v13_task_features(version: str) -> bool:
    return version in {"1.3", "1.3.1"}


def normalize_call(raw: Any, *, require_id: bool, operation_type: str = "MCP") -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("MCP call must be a JSON object")
    if "mutating" in raw or "required" in raw or "classification" in raw:
        raise ValueError("LBP derives classification and authority locally; remove mutating/required/classification")
    call_id = raw.get("id")
    if require_id:
        if not isinstance(call_id, str) or not call_id.strip() or len(call_id) > 128:
            raise ValueError(f"{operation_type} calls require a non-empty id <= 128 characters")
    tool = raw.get("tool")
    arguments = raw.get("arguments", {})
    if not isinstance(tool, str) or not tool:
        raise ValueError("MCP call tool must be a non-empty string")
    if not isinstance(arguments, dict):
        raise ValueError("MCP call arguments must be a JSON object")
    normalized: dict[str, Any] = {"tool": tool, "arguments": arguments}
    if require_id:
        normalized["id"] = call_id.strip()
    if isinstance(raw.get("description"), str):
        normalized["description"] = raw["description"][:1000]
    return normalized


def normalize_operation(op: Any, task_version: str = "1.2") -> dict[str, Any]:
    if not isinstance(op, dict):
        raise ValueError("task.operation must be a JSON object")
    op_type = op.get("type")
    if op_type == "mcp_call":
        op_type = "mcp.call"
    elif op_type == "mcp_list_tools":
        op_type = "mcp.list_tools"
    if op_type not in {"mcp.call", "mcp.list_tools", "mcp.observe", "mcp.mutate"}:
        raise ValueError("LBP supports mcp.call, mcp.list_tools, mcp.observe and mcp.mutate")
    if op_type == "mcp.mutate" and not has_v13_task_features(task_version):
        raise ValueError("mcp.mutate requires LBP 1.3 or 1.3.1")
    if "mutating" in op or "required" in op or "classification" in op:
        raise ValueError("LBP derives classification and authority locally; remove mutating/required/classification")
    normalized: dict[str, Any] = {"type": op_type}
    if isinstance(op.get("description"), str):
        normalized["description"] = op["description"][:1000]
    server = op.get("server")
    if not isinstance(server, str) or not server:
        raise ValueError(f"{op_type}.server must be a non-empty string")
    normalized["server"] = server
    if op_type == "mcp.list_tools":
        return normalized
    if op_type in {"mcp.observe", "mcp.mutate"}:
        calls = op.get("calls")
        if not isinstance(calls, list) or not calls:
            raise ValueError(f"{op_type}.calls must be a non-empty array")
        max_calls = MAX_OBSERVE_CALLS if op_type == "mcp.observe" else MAX_MUTATE_CALLS
        if len(calls) > max_calls:
            raise ValueError(f"{op_type} supports at most {max_calls} calls")
        normalized_calls = [
            normalize_call(call, require_id=True, operation_type=op_type)
            for call in calls
        ]
        ids = [call["id"] for call in normalized_calls]
        if len(set(ids)) != len(ids):
            raise ValueError(f"{op_type} call ids must be unique within the operation")
        normalized["calls"] = normalized_calls
        return normalized
    call = normalize_call(op, require_id=False)
    normalized.update(call)
    return normalized


def normalize_task(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("task must be a JSON object")
    protocol = raw.get("protocol")
    if protocol != "lbp":
        raise ValueError("task.protocol must be 'lbp'")
    # v0.9.2 protocol freeze: runtime support is LBP 1.3 plus backward-compatible
    # 1.2 only. LBP 1.1 is a historical document, never a runtime target -- it is
    # rejected here rather than silently coerced so the daemon is never more
    # permissive than the extension validator.
    raw_version = raw.get("version")
    task_version = "1.2" if raw_version is None else str(raw_version)
    if task_version not in SUPPORTED_LBP_TASK_VERSIONS:
        raise ValueError(
            "task.version must be '1.2' or '1.3'; LBP 1.1 is historical and is not a runtime target"
        )
    task_id = raw.get("id")
    if not isinstance(task_id, str) or not task_id.strip():
        raise ValueError("task.id must be a non-empty string")
    if len(task_id) > 256:
        raise ValueError("task.id must be <= 256 characters")

    operation = raw.get("operation")
    if operation is None and isinstance(raw.get("operations"), list):
        # Single-element operations[] is a canonical LBP 1.2 spelling, not a 1.1
        # compatibility path. The unrestricted multi-operation array is not restored.
        legacy = raw["operations"]
        if len(legacy) != 1:
            raise ValueError("Legacy operations[] is accepted only when it contains exactly one operation")
        operation = dict(legacy[0]) if isinstance(legacy[0], dict) else legacy[0]
        if isinstance(operation, dict):
            operation.pop("mutating", None)
            operation.pop("required", None)
    if operation is None:
        raise ValueError("task.operation is required")

    normalized: dict[str, Any] = {
        "protocol": "lbp",
        "version": task_version,
        "id": task_id,
        "operation": normalize_operation(operation, task_version),
    }
    for field, max_len in (("title", 200), ("description", 1200), ("action_label", 80)):
        value = validate_task_text(raw.get(field), field, max_len)
        if value is not None:
            normalized[field] = value
    if "plan" in raw:
        if not has_v13_task_features(task_version):
            raise ValueError("task.plan requires LBP 1.3 or 1.3.1")
        normalized["plan"] = normalize_plan(raw.get("plan"))
    for field in ("plan_id", "plan_item_id"):
        if field in raw:
            normalized[field] = validate_metadata_id(raw.get(field), f"task.{field}")
    if "plan_revision" in raw:
        try:
            plan_revision = int(raw.get("plan_revision"))
        except (TypeError, ValueError) as exc:
            raise ValueError("task.plan_revision must be an integer") from exc
        if plan_revision < 1:
            raise ValueError("task.plan_revision must be >= 1")
        normalized["plan_revision"] = plan_revision
    if "outputs" in raw:
        if not has_v13_task_features(task_version):
            raise ValueError("task.outputs requires LBP 1.3 or 1.3.1")
        normalized["outputs"] = normalize_outputs(raw.get("outputs"))
    return normalized


def current_tool_catalog(server: str, client: McpHttpClient) -> dict[str, dict[str, Any]]:
    tools_result = client.list_tools()
    catalog = {
        tool.get("name"): tool
        for tool in tools_result.get("tools", [])
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    }
    # Record the classification-relevant shape of the catalog so approvals can be
    # bound to it. Only the derived classification matters, not descriptions.
    shape = {name: tool_classification(tool) for name, tool in catalog.items()}
    with TOOL_CATALOG_GUARD:
        TOOL_CATALOG_FINGERPRINTS[server] = hashlib.sha256(
            canonical_json(shape).encode("utf-8")
        ).hexdigest()
    return catalog


def preflight_call(
    server: str,
    call: dict[str, Any],
    cfg: dict[str, Any],
    client: McpHttpClient,
    catalog: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    tool_name = call["tool"]
    tool = catalog.get(tool_name)
    if not isinstance(tool, dict):
        raise ValueError(f"tool_not_found: {server!r} does not currently expose {tool_name!r}")
    allowed = set(cfg.get("allowed_tools", []))
    # '*' expands only tool eligibility within the live MCP catalog. All other
    # daemon policy gates below remain independently enforced.
    if "*" not in allowed and tool_name not in allowed:
        raise ValueError(f"tool_policy_denied: {server}.{tool_name} is not in allowed_tools")
    arguments = call.get("arguments", {})
    classification, verification = effective_classification(tool, tool_name, arguments, cfg)
    if classification == "write" and not cfg.get("write", False):
        raise ValueError(f"write_policy_denied: {server}.{tool_name} is write; enable writes for this server")
    if classification == "destructive":
        if not cfg.get("write", False):
            raise ValueError(f"write_policy_denied: {server}.{tool_name} is destructive; enable writes for this server")
        if not cfg.get("allow_destructive", False):
            raise ValueError(f"destructive_policy_denied: {server}.{tool_name} requires allow_destructive=true")
    path_checks = check_path_policy(arguments, cfg)
    if verification:
        path_checks.extend(verification_argv_path_checks(verification, cfg))
    result = {
        "tool": tool_name,
        "classification": classification,
        "description": call.get("description"),
        "arguments": arguments,
        "path_checks": path_checks,
    }
    if "id" in call:
        result["id"] = call["id"]
    if verification:
        result["verification"] = verification
    return result


def preflight_operation(op: dict[str, Any]) -> dict[str, Any]:
    op_type = op["type"]
    server = op["server"]
    cfg = get_server_config(server)
    client = get_mcp_client(server)
    if op_type == "mcp.list_tools":
        client.initialize()
        return {
            "type": op_type,
            "server": server,
            "classification": "read_only",
            "description": op.get("description"),
            "arguments": {},
            "path_checks": [],
            "server_info": client.server_info(),
            "protocol_version": client.protocol_version,
        }

    catalog = current_tool_catalog(server, client)
    if op_type in {"mcp.observe", "mcp.mutate"}:
        calls = [preflight_call(server, call, cfg, client, catalog) for call in op["calls"]]
        if op_type == "mcp.observe":
            disallowed = [call for call in calls if call["classification"] not in OBSERVE_CLASSIFICATIONS]
            if disallowed:
                details = ", ".join(f"{call['id']}:{call['tool']}={call['classification']}" for call in disallowed)
                raise ValueError(
                    "observe_policy_denied: mcp.observe accepts only daemon-classified read_only/verify calls; " + details
                )
        else:
            disallowed = [call for call in calls if call["classification"] not in {"write", "destructive"}]
            if disallowed:
                details = ", ".join(f"{call['id']}:{call['tool']}={call['classification']}" for call in disallowed)
                raise ValueError(
                    "mutate_policy_denied: mcp.mutate accepts only daemon-classified write/destructive calls; " + details
                )
        classification = max((call["classification"] for call in calls), key=lambda item: RISK_RANK[item])
        return {
            "type": op_type,
            "server": server,
            "classification": classification,
            "description": op.get("description"),
            "calls": calls,
            "server_info": client.server_info(),
            "protocol_version": client.protocol_version,
        }

    call = preflight_call(server, op, cfg, client, catalog)
    return {
        "type": op_type,
        "server": server,
        **call,
        "server_info": client.server_info(),
        "protocol_version": client.protocol_version,
    }


def preflight_task(
    raw: Any,
    session_id: str | None = None,
    window_id: str | None = None,
    conversation_id: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    session_id = validate_browser_session_id(session_id)
    task = normalize_task(raw)
    operation = preflight_operation(task["operation"])
    cfg = get_server_config(operation["server"])
    approval = approval_decision(operation["server"], operation["classification"], cfg, conversation_id, window_id)
    preview = {
        "protocol": "lbp",
        "version": LBP_VERSION,
        "bridge_version": VERSION,
        "task_id": task["id"],
        "title": task.get("title"),
        "description": task.get("description"),
        "action_label": task.get("action_label"),
        "operation": operation,
        "approval": approval,
    }
    return task, preview


def execute_preflighted_call(
    server: str,
    call: dict[str, Any],
    pre: dict[str, Any],
) -> tuple[dict[str, Any], str, list[dict[str, Any]]]:
    classification = pre["classification"]
    started = time.time()
    result: dict[str, Any] = {
        "server": server,
        "tool": call["tool"],
        "classification": classification,
        "description": call.get("description"),
        "truncated": False,
    }
    if "id" in call:
        result["id"] = call["id"]
    status = "ok"
    applied_mutations: list[dict[str, Any]] = []
    mutating = classification in {"write", "destructive"}

    # LBP 1.3 mutation ambiguity rule.
    #
    # Once a WRITE/DESTRUCTIVE call has been dispatched, any outcome that is not
    # an unambiguous success is `unknown`, never `error`. `unknown` is stronger
    # than `error`, not softer: it stops the chain and requires explicit human
    # acknowledgement. A false `unknown` costs one click; a false `error` invites
    # the assistant to retry an operation that may already have been applied.
    #
    # Pre-dispatch failures stay ordinary `error`, so the common path is
    # unaffected, and READ/VERIFY failures stay `error` throughout.
    try:
        raw_result = get_mcp_client(server).call_tool(
            call["tool"],
            call.get("arguments", {}),
            allow_session_retry=not mutating,
        )
        clipped, truncated = clip_mcp_value(raw_result)
        result["result"] = clipped
        result["truncated"] = truncated
        result["mcp_is_error"] = bool(raw_result.get("isError", False)) if isinstance(raw_result, dict) else False
        if result["mcp_is_error"]:
            # The tool ran and reported failure. For a mutating tool that says
            # nothing about whether it applied anything first -- a patch that
            # failed at hunk 3 of 5 has already written hunks 1 and 2.
            if mutating:
                status = "unknown"
                result["execution_state"] = "unknown"
                result["ambiguity_reason"] = "mcp_is_error_after_dispatch"
            else:
                status = "error"
                result["execution_state"] = "failed"
        elif mutating:
            applied_mutations.append({
                "server": server,
                "tool": call.get("tool"),
                "classification": classification,
            })
    except (socket.timeout, TimeoutError) as exc:
        result["error"] = f"timeout: {exc}"
        if mutating:
            status = "unknown"
            result["execution_state"] = "unknown"
            result["ambiguity_reason"] = "timeout_after_dispatch"
        else:
            status = "error"
            result["execution_state"] = "failed"
    except Exception as exc:
        result["error"] = str(exc)
        # Default to dispatched. Anything raised after the HTTP client returned
        # -- malformed body, id mismatch, JSON-RPC error object, oversize
        # response -- carries no marker and must be assumed to have reached the
        # server.
        dispatched = bool(getattr(exc, "lbp_dispatched", True))
        if mutating and dispatched:
            status = "unknown"
            result["execution_state"] = "unknown"
            result["ambiguity_reason"] = "exception_after_dispatch"
        else:
            status = "error"
            result["execution_state"] = "failed"
    result["status"] = status
    result["duration_ms"] = int((time.time() - started) * 1000)
    return result, status, applied_mutations


def execute_task(task: dict[str, Any], preview: dict[str, Any]) -> dict[str, Any]:
    op = task["operation"]
    pre = preview["operation"]
    classification = pre["classification"]
    server = op["server"]
    started = time.time()
    operation_result: dict[str, Any] = {
        "type": op["type"],
        "server": server,
        "description": op.get("description"),
        "classification": classification,
        "server_info": pre.get("server_info", {}),
        "protocol_version": pre.get("protocol_version"),
        "truncated": False,
    }
    status = "ok"
    applied_mutations: list[dict[str, Any]] = []
    lock = server_rw_lock(server)

    if op["type"] == "mcp.observe":
        operation_result["calls"] = []
        # Entire observation phase shares one side of the barrier, so no write can
        # interleave between source reads and verification calls in this group.
        with lock.read():
            for call, call_pre in zip(op["calls"], pre["calls"]):
                call_result, call_status, _ = execute_preflighted_call(server, call, call_pre)
                operation_result["calls"].append(call_result)
                operation_result["truncated"] = operation_result["truncated"] or bool(call_result.get("truncated"))
                if call_status != "ok":
                    status = "error"
    elif op["type"] == "mcp.mutate":
        operation_result["calls"] = []
        failed = 0
        skipped = 0
        stopped = False
        # A mutation batch owns the exclusive server barrier for the whole ordered
        # phase. Successful earlier calls are not rolled back if a later call fails.
        with lock.write():
            for call, call_pre in zip(op["calls"], pre["calls"]):
                if stopped:
                    operation_result["calls"].append({
                        "id": call["id"],
                        "server": server,
                        "tool": call["tool"],
                        "classification": call_pre["classification"],
                        "description": call.get("description"),
                        "status": "skipped",
                        "execution_state": "not_attempted",
                        "reason": "stopped_after_previous_failure",
                        "truncated": False,
                        "duration_ms": 0,
                    })
                    skipped += 1
                    continue

                call_result, call_status, mutations = execute_preflighted_call(server, call, call_pre)
                operation_result["calls"].append(call_result)
                operation_result["truncated"] = operation_result["truncated"] or bool(call_result.get("truncated"))
                applied_mutations.extend(mutations)

                if call_status == "unknown":
                    status = "unknown"
                    failed += 1
                    stopped = True
                elif call_status != "ok":
                    status = "error"
                    failed += 1
                    stopped = True

        operation_result["planned_calls"] = len(op["calls"])
        operation_result["applied_calls"] = len(applied_mutations)
        operation_result["failed_calls"] = failed
        operation_result["skipped_calls"] = skipped
        partial = bool(applied_mutations) and (failed > 0 or skipped > 0)
        operation_result["partial_execution"] = partial
        if partial and status != "unknown":
            # Some calls landed and the batch then stopped. There is no rollback,
            # so retrying the whole batch would re-apply what already succeeded.
            # The task status is what the assistant reads, so it must say
            # "ambiguous", not "failed" -- the partial_execution flag alone is
            # buried in the operation body.
            status = "unknown"
            operation_result["ambiguity_reason"] = "partial_mutation_batch"
    elif op["type"] == "mcp.list_tools":
        with lock.read():
            try:
                raw_result = get_mcp_client(server).list_tools(refresh=True)
                clipped, truncated = clip_mcp_value(raw_result)
                operation_result["result"] = clipped
                operation_result["truncated"] = truncated
            except Exception as exc:
                operation_result["error"] = str(exc)
                operation_result["execution_state"] = "failed"
                status = "error"
    else:
        operation_result["tool"] = op["tool"]
        barrier = lock.read if classification in OBSERVE_CLASSIFICATIONS else lock.write
        with barrier():
            call_result, status, mutations = execute_preflighted_call(server, op, pre)
        for key in ("result", "error", "execution_state", "mcp_is_error", "truncated"):
            if key in call_result:
                operation_result[key] = call_result[key]
        applied_mutations.extend(mutations)

    operation_result["duration_ms"] = int((time.time() - started) * 1000)
    return {
        "protocol": "lbp",
        # Result transport remains the legacy 1.3 shape until 1.3.1 body/file
        # delivery is implemented end-to-end. A 1.3.1 task has 1.3 semantics,
        # but must not cause a legacy-shaped result to be mislabeled 1.3.1.
        "version": LBP_VERSION,
        "bridge_version": VERSION,
        "task_id": task["id"],
        "title": task.get("title"),
        "status": status,
        "completed_at": int(time.time()),
        "operation": operation_result,
        "applied_mutations": applied_mutations,
        "outputs": [
            {
                **output,
                "status": "produced" if status == "ok" else "unknown" if status == "unknown" else "failed",
            }
            for output in task.get("outputs", [])
        ],
    }


# --- Registered-task execution ------------------------------------------------


def evict_superseded_chain_leases(chain_id: Any, current_window: int) -> None:
    """Drop chain leases for windows the conversation has already left.

    They are unreachable anyway (chain_id is random per chain and window only
    increases), but leaving them to age out means a superseded grant lingers in
    memory for the full lease TTL. Evict eagerly.
    """
    if not isinstance(chain_id, str) or not chain_id:
        return
    prefix = f"{chain_id}.w"
    with APPROVAL_LOCK:
        for key in list(CHAIN_LEASES):
            window_id = key[1] if isinstance(key, tuple) and len(key) > 1 else None
            if not isinstance(window_id, str) or not window_id.startswith(prefix):
                continue
            try:
                window = int(window_id[len(prefix):])
            except ValueError:
                continue
            if window < current_window:
                CHAIN_LEASES.pop(key, None)


def conversation_execution_context(conversation_id: str, registration_id: Any) -> tuple[dict[str, Any], str]:
    """Resolve a registration and prove it is executable right now.

    This is the hard daemon-side stale-execution barrier. A browser bug, a
    reload, provider virtualization or a rediscovered historical task cannot get
    past it, because currentness is decided from daemon state and never from
    anything the browser asserts.

    Returns (journal record, daemon-derived approval window id).
    """
    conversation_id = validate_conversation_id(conversation_id)
    record = resolve_registration(registration_id)
    if record.get("conversation_id") != conversation_id:
        raise ValueError("stale_task: registration does not belong to this conversation")

    with conversation_state_lock(conversation_id):
        state = load_conversation_state(conversation_id)

    if state.get("phase") == "disabled":
        raise ValueError("stale_task: the bridge is switched off for this conversation")
    if state.get("phase") in {"stopped", "disabled"}:
        raise ValueError(f"stale_task: conversation is {state.get('phase')}")
    chain = state.get("active_chain")
    if not isinstance(chain, dict):
        raise ValueError("stale_task: conversation has no active chain")
    if record.get("registration_id") != state.get("current_registration"):
        raise ValueError("stale_task: this is not the current registered task for the conversation")
    if record.get("chain_id") != chain.get("chain_id"):
        raise ValueError("stale_task: task belongs to a superseded chain")
    if int(record.get("window", -1)) != int(chain.get("window", 0)):
        raise ValueError("stale_task: task belongs to a superseded checkpoint window")

    # Derived here, never accepted from the browser. Approval/checkpoint scope
    # survives human follow-up turns even though chain_id intentionally does not.
    approval_scope_id = chain.get("approval_scope_id") or chain.get("chain_id")
    window_id = f"{approval_scope_id}.w{int(chain.get('window', 0))}"
    return record, window_id


def preview_registered_task(
    conversation_id: str,
    registration_id: Any,
    session_id: str | None,
) -> dict[str, Any]:
    record, window_id = conversation_execution_context(conversation_id, registration_id)
    _, preview = preflight_task(record["task"], session_id, window_id, conversation_id)
    preview["registration_id"] = record["registration_id"]
    preview["execution_status"] = record.get("execution_status")
    preview["delivery_status"] = record.get("delivery_status")
    return preview


def approve_registered_task(
    conversation_id: str,
    registration_id: Any,
    session_id: str | None,
    decision: Any,
) -> dict[str, Any]:
    record, window_id = conversation_execution_context(conversation_id, registration_id)
    return grant_approval(record["task"], session_id, decision, window_id, conversation_id)


def execute_registered_task(
    conversation_id: str,
    registration_id: Any,
    session_id: str | None,
    approval_token: str | None,
) -> tuple[dict[str, Any], bool, str]:
    session_id = validate_browser_session_id(session_id)
    record, window_id = conversation_execution_context(conversation_id, registration_id)
    key = record["key"]

    with task_lock(key):
        record = load_journal(key) or record
        status = record.get("execution_status")

        # Replay resolves only AFTER policy is re-evaluated, so a stored result
        # can never be returned for an operation the current policy would now
        # refuse -- server removed, tool disallowed, roots narrowed.
        task, preview = preflight_task(record["task"], session_id, window_id, conversation_id)

        if status in {"completed", "error", "unknown"} and isinstance(record.get("result"), dict):
            record = _ensure_delivery_binding(record)
            save_journal(record)
            return record["result"], True, key

        if status == "executing":
            raise ValueError(
                "ambiguous_task_state: this task was dispatched and no result was recorded; "
                "do not retry automatically. "
                f"Acknowledge with DELETE /v1/tasks/{key}?acknowledge_ambiguous=true"
            )

        # Both "registered" and "running" mean NOT DISPATCHED -- "running" is only
        # the browser saying it has started the round trip. Only "executing" means
        # a call actually went out, and that is the one state we refuse.
        # Rejecting "running" here bricked every task: the coordinator reported
        # running, then the daemon refused to execute the task it had just been
        # told about.
        if status not in {"registered", "running"}:
            raise ValueError(f"task is not executable from status {status!r}")

        authorize_execution(task, preview, session_id, approval_token)

        # The dispatch marker. Only this transition makes a crash ambiguous;
        # a registered-but-never-dispatched task stays cleanly executable.
        record["execution_status"] = "executing"
        record["dispatched_at"] = int(time.time())
        record = save_journal(record)

        result = execute_task(task, preview)

        record["result"] = result
        record["execution_status"] = (
            "completed" if result["status"] == "ok"
            else "unknown" if result["status"] == "unknown"
            else "error"
        )
        record["delivery_status"] = "none"
        _ensure_delivery_binding(record)
        save_journal(record)
        return result, False, key


def recover_ambiguous_task(key: str, acknowledged: bool) -> None:
    if not acknowledged:
        raise ValueError("set acknowledge_ambiguous=true to clear an unfinished journal")
    if len(key) != 64 or any(ch not in "0123456789abcdef" for ch in key):
        raise ValueError("invalid task journal key")
    with task_lock(key):
        record = load_journal(key)
        if record is None:
            raise ValueError("ambiguous journal not found")
        if isinstance(record.get("result"), dict):
            raise ValueError("completed task journals are not deleted by recovery")
        if record.get("execution_status") != "executing":
            raise ValueError("only a dispatched-but-unfinished task can be recovered")
        record["execution_status"] = "unknown"
        record["recovered_at"] = int(time.time())
        record["result"] = {
            "protocol": "lbp",
            "version": LBP_VERSION,
            "bridge_version": VERSION,
            "task_id": record.get("task_id"),
            "title": record.get("title"),
            "status": "unknown",
            "completed_at": int(time.time()),
            "operation": {"execution_state": "unknown", "error": "acknowledged_ambiguous_dispatch"},
            "applied_mutations": [],
        }
        save_journal(record)


def valid_host(host_header: str | None) -> bool:
    if not host_header:
        return False
    return host_header in {f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"[::1]:{PORT}"}


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalMcpBridge/0.9.2.2"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return secrets.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}")

    def _guard(self) -> bool:
        if not valid_host(self.headers.get("Host")):
            self._send(421, {"ok": False, "error": "invalid Host header"})
            return False
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return False
        return True

    def do_OPTIONS(self) -> None:
        if not valid_host(self.headers.get("Host")):
            self._send(421, {"ok": False, "error": "invalid Host header"})
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_REQUEST_BODY:
            raise ValueError(f"request body must be 1..{MAX_REQUEST_BODY} bytes")
        raw = self.rfile.read(length)
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        return value

    def do_GET(self) -> None:
        if not self._guard():
            return
        if self.path == "/health":
            self._send(200, {
                "ok": True,
                "service": "local-mcp-bridge",
                "version": VERSION,
                "protocols": [{"name": "lbp", "versions": sorted(SUPPORTED_LBP_TASK_VERSIONS, reverse=True)}],
                "operations": ["mcp.call", "mcp.list_tools", "mcp.observe", "mcp.mutate"],
                "execution_model": "rw-barrier: observe(read+verify) shared, mutate/write/destructive exclusive; mutation batches ordered and stop on first failure",
                "max_observe_calls": MAX_OBSERVE_CALLS,
                "max_mutate_calls": MAX_MUTATE_CALLS,
                "policy": "daemon-enforced",
                "approval_modes": sorted(APPROVAL_MODES),
                "approval_escalations": sorted(APPROVAL_ESCALATIONS),
                "approval_transport": "ephemeral-daemon-tokens",
            })
            return
        if self.path == "/v1/servers":
            snapshot = servers_snapshot()
            self._send(200, {"ok": True, "servers": snapshot, "version": registry_version(snapshot)})
            return
        if self.path == "/v1/context/workspaces":
            self._send(200, {"ok": True, "sources": configured_context_workspaces()})
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if not self._guard():
            return
        try:
            if self.path == "/v1/conversation-state":
                body = self._read_json_body()
                conversation_id = validate_conversation_id(body.get("conversation_id"))
                action = body.get("action", "get")
                if not isinstance(action, str):
                    raise ValueError("conversation state action must be a string")
                payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
                try:
                    state = update_conversation_state(conversation_id, action, payload)
                except ConversationConflict as conflict:
                    # Optimistic-concurrency failure is a normal outcome with two
                    # tabs, not an error: hand back current state so the caller
                    # can reconcile and retry rather than double-applying.
                    self._send(409, {"ok": False, "error": str(conflict), "state": conflict.state})
                    return
                self._send(200, {"ok": True, "state": state})
                return
            if self.path == "/v1/conversation-state/bind":
                body = self._read_json_body()
                state = bind_conversation(body.get("provisional_id"), body.get("canonical_id"))
                self._send(200, {"ok": True, "state": state})
                return
            if self.path == "/v1/context/choose-folder":
                self._read_json_body()
                self._send(200, {"ok": True, **choose_context_folder_native()})
                return
            # Preview / approval / execution all address a task the daemon
            # registered and normalized itself. The browser supplies a handle,
            # never a task body, so task content cannot change between phases.
            if self.path == "/v1/tasks/preview":
                body = self._read_json_body()
                preview = preview_registered_task(
                    body.get("conversation_id"),
                    body.get("registration"),
                    body.get("session_id"),
                )
                self._send(200, {"ok": True, "preview": preview})
                return
            if self.path == "/v1/approvals":
                body = self._read_json_body()
                result = approve_registered_task(
                    body.get("conversation_id"),
                    body.get("registration"),
                    body.get("session_id"),
                    body.get("decision"),
                )
                self._send(200, {"ok": True, **result})
                return
            if self.path == "/v1/tasks":
                body = self._read_json_body()
                result, replayed, key = execute_registered_task(
                    body.get("conversation_id"),
                    body.get("registration"),
                    body.get("session_id"),
                    body.get("approval_token"),
                )
                record = load_journal(key) or {}
                self._send(200, {
                    "ok": True,
                    "result": result,
                    "replayed": replayed,
                    "journal_key": key,
                    "delivery_id": record.get("delivery_id"),
                    "result_digest": record.get("result_digest"),
                })
                return
            if self.path == "/v1/servers":
                body = self._read_json_body()
                servers, version = save_servers(body.get("servers"), body.get("expected_version"))
                self._send(200, {"ok": True, "servers": servers, "version": version})
                return
            if self.path == "/v1/servers/test":
                body = self._read_json_body()
                name = validate_server_name(body.get("name"))
                config = body.get("config")
                if not isinstance(config, dict):
                    with SERVERS_LOCK:
                        config = dict(SERVERS.get(name, {}))
                if not config:
                    raise ValueError(f"no configuration supplied for MCP server {name!r}")
                result = test_server_connection(name, config)
                self._send(200, {"ok": True, "result": result})
                return
            self._send(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            self._send(400, {"ok": False, "error": str(exc)})

    def do_DELETE(self) -> None:
        if not self._guard():
            return
        try:
            parsed = urllib.parse.urlparse(self.path)
            prefix = "/v1/tasks/"
            if not parsed.path.startswith(prefix):
                self._send(404, {"ok": False, "error": "not found"})
                return
            key = parsed.path[len(prefix):]
            query = urllib.parse.parse_qs(parsed.query)
            acknowledged = query.get("acknowledge_ambiguous", [""])[0].lower() == "true"
            recover_ambiguous_task(key, acknowledged)
            self._send(200, {"ok": True, "recovered": key})
        except Exception as exc:
            self._send(400, {"ok": False, "error": str(exc)})

def _debug_state(event: str, state: dict, **extra):
    chain = state.get("active_chain") or {}
    print(
        "[LBP daemon]",
        event,
        {
            "conversation_id": state.get("conversation_id"),
            "revision": state.get("revision"),
            "phase": state.get("phase"),
            "enabled": state.get("enabled"),
            "workflow_attached": state.get("workflow_attached"),
            "pending_human_send": state.get("pending_human_send"),
            "last_user_turn_id": state.get("last_user_turn_id"),
            "last_assistant_turn_id": state.get("last_assistant_turn_id"),
            "current_task_id": state.get("current_task_id"),
            "current_registration": state.get("current_registration"),
            "chain_id": chain.get("chain_id"),
            "window": chain.get("window"),
            "window_task_count": chain.get("window_task_count"),
            "total_task_count": chain.get("total_task_count"),
            **extra,
        },
        flush=True,
    )


if __name__ == "__main__":
    print(f"Local MCP Bridge v{VERSION} listening on http://{HOST}:{PORT}")
    print(f"State: {STATE_DIR} (0700), journals: {TASK_DIR} (0600 files)")
    print(f"MCP servers: {SERVERS_FILE}")
    for name, cfg in servers_snapshot().items():
        state = "enabled" if cfg.get("enabled", True) else "disabled"
        print(
            f"  {name}: {cfg.get('endpoint')} ({state}; allowed={len(cfg.get('allowed_tools', []))}; "
            f"writes={'on' if cfg.get('write') else 'off'})"
        )
    print("LBP 1.3: bounded read/verify observation groups + ordered bounded mutation batches; daemon-derived policy + configurable approvals")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
