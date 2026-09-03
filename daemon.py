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
import tempfile
import threading
import time
import urllib.parse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterable

VERSION = "0.9.0"
LBP_VERSION = "1.2"
HOST = "127.0.0.1"
PORT = int(os.environ.get("LOCAL_MCP_BRIDGE_PORT", os.environ.get("ATLAS_ARMS_PORT", "8765")))
STATE_DIR = pathlib.Path.home() / ".local-mcp-bridge"
TOKEN_FILE = STATE_DIR / "token"
SERVERS_FILE = STATE_DIR / "servers.json"
TASK_DIR = STATE_DIR / "tasks"
MAX_REQUEST_BODY = 512 * 1024
MAX_MCP_BODY = 4 * 1024 * 1024
MAX_RESULT_STRING = 64 * 1024
MAX_TIMEOUT = 180
MCP_REQUESTED_PROTOCOL_VERSION = "2025-11-25"
MCP_CLIENT_IDLE_SECONDS = 300
APPROVAL_TOKEN_TTL_SECONDS = 120
SESSION_LEASE_TTL_SECONDS = 2 * 60 * 60
APPROVAL_MODES = {"all", "session", "mutations", "none"}
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
    os.chmod(STATE_DIR, 0o700)
    os.chmod(TASK_DIR, 0o700)
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


def registry_version(servers: dict[str, dict[str, Any]] | None = None) -> str:
    snapshot = servers if servers is not None else servers_snapshot()
    return hashlib.sha256(canonical_json(snapshot).encode("utf-8")).hexdigest()


ensure_state_permissions()
TOKEN = load_token()
SERVERS = load_servers()
SERVERS_LOCK = threading.RLock()
TASK_LOCKS_GUARD = threading.RLock()
TASK_LOCKS: dict[str, threading.RLock] = {}
MCP_POOL_LOCK = threading.RLock()
MCP_POOL: dict[str, tuple[str, "McpHttpClient"]] = {}
APPROVAL_LOCK = threading.RLock()
# Approval state is intentionally ephemeral. Daemon restart or browser-tab session change clears trust.
SESSION_LEASES: dict[tuple[str, str], dict[str, Any]] = {}
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
        try:
            conn.request("POST", self._path(), body=body, headers=headers)
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

    def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            return self._rpc_once(method, params)
        except McpHttpError as exc:
            if exc.status != 404 or not self.session_id:
                raise
            self.reset_session()
            return self._rpc_once(method, params)

    def call_tool(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            return self._rpc("tools/call", {"name": tool, "arguments": arguments})

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
    if base != "write":
        return base, None
    verification = verification_match(tool_name, arguments, cfg)
    if verification:
        return "verify", verification
    return "write", None


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


def is_path_key(key: str) -> bool:
    lower = key.lower()
    return lower in PATH_KEYS or lower.endswith("_path") or lower.endswith("_dir")


def values_from_path_field(value: Any) -> Iterable[str]:
    if isinstance(value, str) and value.strip():
        yield value
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item.strip():
                yield item


def collect_path_arguments(value: Any, prefix: str = "", path_key_context: bool = False) -> list[tuple[str, str]]:
    """Collect local path-like strings by value, not only by argument name.

    Absolute paths (including values that become absolute after ``~`` expansion)
    are always policy-relevant regardless of the key chosen by an MCP server.
    Known path keys remain useful for rejecting ambiguous relative paths.
    """
    found: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key)
            location = f"{prefix}.{key_text}" if prefix else key_text
            found.extend(collect_path_arguments(child, location, path_key_context or is_path_key(key_text)))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(collect_path_arguments(child, f"{prefix}[{index}]", path_key_context))
    elif isinstance(value, str) and value.strip():
        raw = value.strip()
        expanded = pathlib.Path(raw).expanduser()
        if expanded.is_absolute() or path_key_context:
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
    material = {"server": server, "config": cfg}
    return hashlib.sha256(canonical_json(material).encode("utf-8")).hexdigest()


def cleanup_approval_state() -> None:
    now = time.time()
    with APPROVAL_LOCK:
        for key, lease in list(SESSION_LEASES.items()):
            if lease.get("expires_at", 0) <= now:
                SESSION_LEASES.pop(key, None)
        for token, approval in list(ONCE_APPROVALS.items()):
            if approval.get("expires_at", 0) <= now:
                ONCE_APPROVALS.pop(token, None)


def session_lease_covers(
    session_id: str | None,
    server: str,
    classification: str,
    cfg: dict[str, Any],
) -> bool:
    if not session_id:
        return False
    cleanup_approval_state()
    with APPROVAL_LOCK:
        lease = SESSION_LEASES.get((session_id, server))
        if not lease:
            return False
        if lease.get("policy_fingerprint") != policy_fingerprint(server, cfg):
            SESSION_LEASES.pop((session_id, server), None)
            return False
        return int(lease.get("max_risk", -1)) >= RISK_RANK.get(classification, 99)


def approval_decision(
    server: str,
    classification: str,
    cfg: dict[str, Any],
    session_id: str | None,
) -> dict[str, Any]:
    mode = cfg.get("approval_mode", "mutations")
    if classification == "destructive" and cfg.get("always_approve_destructive", True):
        return {
            "required": True,
            "reason": "destructive_always",
            "mode": mode,
            "session_approval_available": False,
        }
    if mode == "none":
        return {"required": False, "reason": "policy_auto", "mode": mode, "session_approval_available": False}
    if mode == "mutations":
        required = classification in {"write", "destructive"}
        auto_reason = "verify_auto" if classification == "verify" else "read_auto"
        return {
            "required": required,
            "reason": "mutation" if required else auto_reason,
            "mode": mode,
            "session_approval_available": False,
        }
    if mode == "all":
        return {"required": True, "reason": "all_operations", "mode": mode, "session_approval_available": False}
    if mode == "session":
        covered = session_lease_covers(session_id, server, classification, cfg)
        return {
            "required": not covered,
            "reason": "session_lease" if covered else "session_required",
            "mode": mode,
            "session_approval_available": not covered and bool(session_id),
            "session_ttl_seconds": SESSION_LEASE_TTL_SECONDS,
        }
    raise ValueError(f"invalid approval mode {mode!r}")


def task_digest(task: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(task).encode("utf-8")).hexdigest()


def grant_approval(
    raw_task: Any,
    session_id: str | None,
    decision: str,
) -> dict[str, Any]:
    session_id = validate_browser_session_id(session_id)
    task, preview = preflight_task(raw_task, session_id)
    approval = preview["approval"]
    if not approval.get("required"):
        return {"approval_required": False, "approval_token": None, "session_granted": False}
    if decision not in {"once", "session"}:
        raise ValueError("approval decision must be 'once' or 'session'")
    if decision == "session" and not approval.get("session_approval_available"):
        raise ValueError("session approval is not available for this operation under current policy")

    op = preview["operation"]
    server = op["server"]
    cfg = get_server_config(server)
    if decision == "session":
        assert session_id is not None
        with APPROVAL_LOCK:
            SESSION_LEASES[(session_id, server)] = {
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


def normalize_call(raw: Any, *, require_id: bool) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("MCP call must be a JSON object")
    if "mutating" in raw or "required" in raw or "classification" in raw:
        raise ValueError("LBP derives classification and authority locally; remove mutating/required/classification")
    call_id = raw.get("id")
    if require_id:
        if not isinstance(call_id, str) or not call_id.strip() or len(call_id) > 128:
            raise ValueError("mcp.observe calls require a non-empty id <= 128 characters")
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


def normalize_operation(op: Any) -> dict[str, Any]:
    if not isinstance(op, dict):
        raise ValueError("task.operation must be a JSON object")
    op_type = op.get("type")
    if op_type == "mcp_call":
        op_type = "mcp.call"
    elif op_type == "mcp_list_tools":
        op_type = "mcp.list_tools"
    if op_type not in {"mcp.call", "mcp.list_tools", "mcp.observe"}:
        raise ValueError("LBP 1.2 supports mcp.call, mcp.list_tools and mcp.observe")
    if "mutating" in op or "required" in op or "classification" in op:
        raise ValueError("LBP 1.2 derives classification and authority locally; remove mutating/required/classification")
    normalized: dict[str, Any] = {"type": op_type}
    if isinstance(op.get("description"), str):
        normalized["description"] = op["description"][:1000]
    server = op.get("server")
    if not isinstance(server, str) or not server:
        raise ValueError(f"{op_type}.server must be a non-empty string")
    normalized["server"] = server
    if op_type == "mcp.list_tools":
        return normalized
    if op_type == "mcp.observe":
        calls = op.get("calls")
        if not isinstance(calls, list) or not calls:
            raise ValueError("mcp.observe.calls must be a non-empty array")
        if len(calls) > MAX_OBSERVE_CALLS:
            raise ValueError(f"mcp.observe supports at most {MAX_OBSERVE_CALLS} calls")
        normalized_calls = [normalize_call(call, require_id=True) for call in calls]
        ids = [call["id"] for call in normalized_calls]
        if len(set(ids)) != len(ids):
            raise ValueError("mcp.observe call ids must be unique within the operation")
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
    version = raw.get("version")
    if version not in {LBP_VERSION, "1.1", 1, "1"}:
        raise ValueError(f"task.version must be {LBP_VERSION!r}")
    task_id = raw.get("id")
    if not isinstance(task_id, str) or not task_id.strip():
        raise ValueError("task.id must be a non-empty string")
    if len(task_id) > 256:
        raise ValueError("task.id must be <= 256 characters")

    operation = raw.get("operation")
    if operation is None and isinstance(raw.get("operations"), list):
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
        "version": LBP_VERSION,
        "id": task_id,
        "operation": normalize_operation(operation),
    }
    for field, max_len in (("title", 200), ("description", 1200), ("action_label", 80)):
        value = validate_task_text(raw.get(field), field, max_len)
        if value is not None:
            normalized[field] = value
    return normalized


def current_tool_catalog(server: str, client: McpHttpClient) -> dict[str, dict[str, Any]]:
    tools_result = client.list_tools()
    return {
        tool.get("name"): tool
        for tool in tools_result.get("tools", [])
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    }


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
    if tool_name not in allowed:
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
    if op_type == "mcp.observe":
        calls = [preflight_call(server, call, cfg, client, catalog) for call in op["calls"]]
        disallowed = [call for call in calls if call["classification"] not in OBSERVE_CLASSIFICATIONS]
        if disallowed:
            details = ", ".join(f"{call['id']}:{call['tool']}={call['classification']}" for call in disallowed)
            raise ValueError(
                "observe_policy_denied: mcp.observe accepts only daemon-classified read_only/verify calls; " + details
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


def preflight_task(raw: Any, session_id: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    session_id = validate_browser_session_id(session_id)
    task = normalize_task(raw)
    operation = preflight_operation(task["operation"])
    cfg = get_server_config(operation["server"])
    approval = approval_decision(operation["server"], operation["classification"], cfg, session_id)
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
    try:
        raw_result = get_mcp_client(server).call_tool(call["tool"], call.get("arguments", {}))
        clipped, truncated = clip_mcp_value(raw_result)
        result["result"] = clipped
        result["truncated"] = truncated
        result["mcp_is_error"] = bool(raw_result.get("isError", False)) if isinstance(raw_result, dict) else False
        if result["mcp_is_error"]:
            status = "error"
        elif classification in {"write", "destructive"}:
            applied_mutations.append({
                "server": server,
                "tool": call.get("tool"),
                "classification": classification,
            })
    except (socket.timeout, TimeoutError) as exc:
        result["error"] = f"timeout: {exc}"
        if classification in {"write", "destructive"}:
            result["execution_state"] = "unknown"
            status = "unknown"
        else:
            result["execution_state"] = "failed"
            status = "error"
    except Exception as exc:
        result["error"] = str(exc)
        if classification in {"write", "destructive"} and isinstance(exc, (ConnectionError, http.client.HTTPException, OSError)):
            result["execution_state"] = "unknown"
            status = "unknown"
        else:
            result["execution_state"] = "failed"
            status = "error"
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
        "version": LBP_VERSION,
        "bridge_version": VERSION,
        "task_id": task["id"],
        "title": task.get("title"),
        "status": status,
        "completed_at": int(time.time()),
        "operation": operation_result,
        "applied_mutations": applied_mutations,
    }


def task_key(task_id: str) -> str:
    return hashlib.sha256(task_id.encode("utf-8")).hexdigest()


def task_lock(key: str) -> threading.RLock:
    with TASK_LOCKS_GUARD:
        return TASK_LOCKS.setdefault(key, threading.RLock())


def task_paths(key: str) -> tuple[pathlib.Path, pathlib.Path]:
    return TASK_DIR / f"{key}.task.json", TASK_DIR / f"{key}.result.json"


def execute_journaled(
    raw_task: Any,
    session_id: str | None = None,
    approval_token: str | None = None,
) -> tuple[dict[str, Any], bool, str]:
    session_id = validate_browser_session_id(session_id)
    # Replay is a journal read, not another local MCP execution. Resolve it before
    # contacting the MCP server or asking for a fresh approval.
    task = normalize_task(raw_task)
    key = task_key(task["id"])
    task_path, result_path = task_paths(key)
    lock = task_lock(key)
    with lock:
        canonical = canonical_json(task)
        if task_path.exists():
            previous = json.loads(task_path.read_text(encoding="utf-8"))
            if canonical_json(previous) != canonical:
                raise ValueError(f"task id {task['id']!r} already exists with different content; use a new task id")
            if result_path.exists():
                return json.loads(result_path.read_text(encoding="utf-8")), True, key
            raise ValueError(
                "ambiguous_task_state: journal exists without a result; do not retry automatically. "
                f"Recovery key: {key}"
            )
        task, preview = preflight_task(task, session_id)
        authorize_execution(task, preview, session_id, approval_token)
        atomic_write_json(task_path, task)
        result = execute_task(task, preview)
        atomic_write_json(result_path, result)
        return result, False, key


def recover_ambiguous_task(key: str, acknowledged: bool) -> None:
    if not acknowledged:
        raise ValueError("set acknowledge_ambiguous=true to clear an unfinished journal")
    if len(key) != 64 or any(ch not in "0123456789abcdef" for ch in key):
        raise ValueError("invalid task journal key")
    task_path, result_path = task_paths(key)
    with task_lock(key):
        if result_path.exists():
            raise ValueError("completed task journals are not deleted by recovery")
        if not task_path.exists():
            raise ValueError("ambiguous journal not found")
        task_path.unlink()


def valid_host(host_header: str | None) -> bool:
    if not host_header:
        return False
    return host_header in {f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"[::1]:{PORT}"}


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalMcpBridge/0.9"

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
                "protocols": [{"name": "lbp", "versions": [LBP_VERSION]}],
                "operations": ["mcp.call", "mcp.list_tools", "mcp.observe"],
                "execution_model": "rw-barrier: observe(read+verify) shared, write/destructive exclusive",
                "max_observe_calls": MAX_OBSERVE_CALLS,
                "policy": "daemon-enforced",
                "approval_modes": sorted(APPROVAL_MODES),
                "approval_transport": "ephemeral-daemon-tokens",
            })
            return
        if self.path == "/v1/servers":
            snapshot = servers_snapshot()
            self._send(200, {"ok": True, "servers": snapshot, "version": registry_version(snapshot)})
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if not self._guard():
            return
        try:
            if self.path == "/v1/tasks/preview":
                body = self._read_json_body()
                raw_task = body.get("task") if isinstance(body.get("task"), dict) else body
                session_id = body.get("session_id") if raw_task is not body else None
                _, preview = preflight_task(raw_task, session_id)
                self._send(200, {"ok": True, "preview": preview})
                return
            if self.path == "/v1/approvals":
                body = self._read_json_body()
                raw_task = body.get("task")
                if not isinstance(raw_task, dict):
                    raise ValueError("task is required")
                result = grant_approval(raw_task, body.get("session_id"), body.get("decision"))
                self._send(200, {"ok": True, **result})
                return
            if self.path == "/v1/tasks":
                body = self._read_json_body()
                raw_task = body.get("task") if isinstance(body.get("task"), dict) else body
                session_id = body.get("session_id") if raw_task is not body else None
                approval_token = body.get("approval_token") if raw_task is not body else None
                result, replayed, key = execute_journaled(raw_task, session_id, approval_token)
                self._send(200, {"ok": True, "result": result, "replayed": replayed, "journal_key": key})
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
    print("LBP 1.2: read/verify observation groups + exclusive writes; daemon-derived policy + configurable approvals")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
