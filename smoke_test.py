#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import http.client
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent
TOKEN = "smoke-token"
NEGOTIATED = "2025-06-18"


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class MockMcp(BaseHTTPRequestHandler):
    session_counter = 0
    calls: list[dict] = []
    flaky_404_sent = False

    def log_message(self, *_args):
        pass

    def _json(self, status, body, session=None, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if session:
            self.send_header("Mcp-Session-Id", session)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_DELETE(self):
        MockMcp.calls.append({"method": "DELETE", "session": self.headers.get("Mcp-Session-Id")})
        self._json(200, {"ok": True})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        msg = json.loads(raw or b"{}")
        method = msg.get("method")
        MockMcp.calls.append({
            "method": method,
            "id": msg.get("id"),
            "tool": msg.get("params", {}).get("name") if method == "tools/call" else None,
            "session": self.headers.get("Mcp-Session-Id"),
            "protocol_header": self.headers.get("MCP-Protocol-Version"),
        })
        if method == "initialize":
            MockMcp.session_counter += 1
            session = f"session-{MockMcp.session_counter}"
            self._json(200, {
                "jsonrpc": "2.0", "id": msg["id"],
                "result": {
                    "protocolVersion": NEGOTIATED,
                    "capabilities": {},
                    "serverInfo": {"name": "mock-workspace", "version": "1.0"},
                }
            }, session=session)
            return
        if method == "notifications/initialized":
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if method == "tools/list":
            tools = [
                {"name": "read_file", "description": "read", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}},
                {"name": "flaky_read", "description": "read after restart", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}},
                {"name": "slow_read", "description": "slow read", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}},
                {"name": "run_command", "description": "command", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": False}},
                {"name": "apply_patch", "description": "write", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": False}},
                {"name": "delete_all", "description": "destroy", "inputSchema": {"type": "object"}, "annotations": {"destructiveHint": True}},
            ]
            result = {"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": tools}}
            notification = {"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}}
            body = (
                f"data: {json.dumps(result)}\n\n"
                f"data: {json.dumps(notification)}\n\n"
            ).encode()
            self._json(200, body, content_type="text/event-stream")
            return
        if method == "tools/call":
            name = msg.get("params", {}).get("name")
            if name == "flaky_read" and not MockMcp.flaky_404_sent:
                MockMcp.flaky_404_sent = True
                self._json(404, {"error": "session expired"})
                return
            args = msg.get("params", {}).get("arguments", {})
            if name == "slow_read":
                time.sleep(0.2)
            result = {
                "content": [{"type": "text", "text": f"{name}:{args.get('path', '')}"}],
                "isError": False,
            }
            self._json(200, {"jsonrpc": "2.0", "id": msg["id"], "result": result})
            return
        self._json(400, {"error": "unknown"})


def request(port: int, method: str, path: str, body=None, host=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Authorization": f"Bearer {TOKEN}", "Host": host or f"127.0.0.1:{port}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=headers)
    response = conn.getresponse()
    raw = response.read()
    conn.close()
    payload = json.loads(raw or b"{}")
    return response.status, payload


def wait_health(port: int):
    for _ in range(80):
        try:
            status, payload = request(port, "GET", "/health")
            if status == 200 and payload.get("ok"):
                return
        except Exception:
            pass
        time.sleep(0.05)
    raise AssertionError("daemon did not start")


def task(task_id, tool, path):
    return {
        "protocol": "lbp",
        "version": "1.2",
        "id": task_id,
        "title": "smoke",
        "description": "test",
        "operation": {
            "type": "mcp.call",
            "server": "workspace",
            "tool": tool,
            "arguments": {"path": str(path)},
        },
    }


def task_args(task_id, tool, arguments):
    value = task(task_id, tool, pathlib.Path("/tmp/unused"))
    value["operation"]["arguments"] = arguments
    return value


def observe_task(task_id, calls):
    return {
        "protocol": "lbp",
        "version": "1.2",
        "id": task_id,
        "title": "observe smoke",
        "description": "grouped reads and verification",
        "operation": {
            "type": "mcp.observe",
            "server": "workspace",
            "calls": calls,
        },
    }


def main():
    mcp_port = free_port()
    bridge_port = free_port()
    mcp = ThreadingHTTPServer(("127.0.0.1", mcp_port), MockMcp)
    threading.Thread(target=mcp.serve_forever, daemon=True).start()

    with tempfile.TemporaryDirectory() as td:
        home = pathlib.Path(td)
        project = home / "project"
        project.mkdir()
        target = project / "main.rs"
        target.write_text("fn main() {}\n")
        outside = home / "secret.txt"
        outside.write_text("secret\n")
        state = home / ".local-mcp-bridge"
        tasks_dir = state / "tasks"
        tasks_dir.mkdir(parents=True)
        (state / "token").write_text(TOKEN + "\n")
        os.chmod(state / "token", 0o600)
        servers = {
            "workspace": {
                "transport": "http",
                "endpoint": f"http://127.0.0.1:{mcp_port}/mcp",
                "timeout_s": 5,
                "enabled": True,
                "allowed_tools": ["read_file", "flaky_read", "slow_read", "run_command", "apply_patch", "delete_all"],
                "allow_verify": True,
                "verification_rules": [{
                    "tool": "run_command",
                    "argument": "command",
                    "argv_prefixes": [["cargo", "test"], ["cargo", "check"], ["cargo", "clippy"], ["cargo", "fmt", "--check"]],
                }],
                "write": False,
                "allow_destructive": False,
                "roots": [str(project)],
            }
        }
        (state / "servers.json").write_text(json.dumps(servers))
        os.chmod(state / "servers.json", 0o600)

        env = os.environ.copy()
        env["HOME"] = str(home)
        env["LOCAL_MCP_BRIDGE_PORT"] = str(bridge_port)
        proc = subprocess.Popen(["python3", str(ROOT / "daemon.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            wait_health(bridge_port)

            status, health = request(bridge_port, "GET", "/health")
            assert status == 200 and health["protocols"][0]["versions"] == ["1.2"]
            assert set(health["operations"]) == {"mcp.call", "mcp.list_tools", "mcp.observe"}
            assert health["max_observe_calls"] == 8

            legacy_single = {
                "protocol": "lbp", "version": "1.1", "id": "legacy-single",
                "operations": [{
                    "type": "mcp.call", "server": "workspace", "tool": "read_file",
                    "arguments": {"path": str(target)}, "mutating": False, "required": True,
                }],
            }
            status, legacy_preview = request(bridge_port, "POST", "/v1/tasks/preview", legacy_single)
            assert status == 200, legacy_preview
            assert legacy_preview["preview"]["version"] == "1.2"
            assert legacy_preview["preview"]["operation"]["tool"] == "read_file"

            legacy_many = json.loads(json.dumps(legacy_single))
            legacy_many["id"] = "legacy-many"
            legacy_many["operations"].append(json.loads(json.dumps(legacy_many["operations"][0])))
            status, legacy_many_resp = request(bridge_port, "POST", "/v1/tasks/preview", legacy_many)
            assert status == 400 and "exactly one" in legacy_many_resp["error"]
            assert set(health["approval_modes"]) == {"all", "session", "mutations", "none"}

            status, _ = request(bridge_port, "GET", "/health", host="evil.com")
            assert status == 421

            status, registry = request(bridge_port, "GET", "/v1/servers")
            assert status == 200 and len(registry["version"]) == 64
            first_version = registry["version"]

            status, tested = request(bridge_port, "POST", "/v1/servers/test", {"name": "workspace", "config": servers["workspace"]})
            assert status == 200, tested
            assert tested["result"]["tool_count"] == 6
            assert any(t["name"] == "read_file" and t["classification"] == "read_only" for t in tested["result"]["tools"])

            # The client must use the negotiated version after initialize, and omit it on initialize itself.
            init_calls = [c for c in MockMcp.calls if c["method"] == "initialize"]
            assert init_calls and all(c["protocol_header"] is None for c in init_calls)
            post_init = [c for c in MockMcp.calls if c["method"] in {"notifications/initialized", "tools/list"}]
            assert post_init and all(c["protocol_header"] == NEGOTIATED for c in post_init)

            read_task = task("read-1", "read_file", target)
            status, preview = request(bridge_port, "POST", "/v1/tasks/preview", read_task)
            assert status == 200, preview
            assert preview["preview"]["operation"]["classification"] == "read_only"
            assert preview["preview"]["operation"]["path_checks"][0]["root"] == str(project)

            status, denied_path = request(bridge_port, "POST", "/v1/tasks/preview", task("outside", "read_file", outside))
            assert status == 400 and "path_policy_denied" in denied_path["error"]

            status, denied_write = request(bridge_port, "POST", "/v1/tasks/preview", task("write-denied", "apply_patch", target))
            assert status == 400 and "write_policy_denied" in denied_write["error"]

            # VERIFY is a daemon-owned classification. It can auto-run in mutations mode
            # without enabling general write authority, but only for configured argv prefixes.
            verify_task = task_args("verify-cargo-test", "run_command", {
                "command": "cargo test --workspace",
                "cwd": str(project),
            })
            status, verify_preview = request(bridge_port, "POST", "/v1/tasks/preview", verify_task)
            assert status == 200, verify_preview
            assert verify_preview["preview"]["operation"]["classification"] == "verify"
            assert verify_preview["preview"]["approval"]["required"] is False
            assert verify_preview["preview"]["operation"]["verification"]["matched_prefix"] == ["cargo", "test"]
            status, verify_run = request(bridge_port, "POST", "/v1/tasks", verify_task)
            assert status == 200 and verify_run["result"]["status"] == "ok", verify_run
            assert verify_run["result"]["operation"]["classification"] == "verify"
            assert verify_run["result"]["applied_mutations"] == []

            # A model cannot self-declare VERIFY and shell control operators fail closed.
            forged = json.loads(json.dumps(verify_task))
            forged["id"] = "verify-forged"
            forged["operation"]["classification"] = "verify"
            status, forged_resp = request(bridge_port, "POST", "/v1/tasks/preview", forged)
            assert status == 400 and "derives classification" in forged_resp["error"]
            escaped = task_args("verify-shell-escape", "run_command", {
                "command": "cargo test && rm -rf /tmp/nope",
                "cwd": str(project),
            })
            status, escaped_resp = request(bridge_port, "POST", "/v1/tasks/preview", escaped)
            assert status == 400 and "write_policy_denied" in escaped_resp["error"]
            no_cwd = task_args("verify-no-cwd", "run_command", {"command": "cargo test"})
            status, no_cwd_resp = request(bridge_port, "POST", "/v1/tasks/preview", no_cwd)
            assert status == 400 and "write_policy_denied" in no_cwd_resp["error"]
            verify_path_escape = task_args("verify-path-escape", "run_command", {
                "command": f"cargo test --manifest-path {outside}",
                "cwd": str(project),
            })
            status, verify_path_resp = request(bridge_port, "POST", "/v1/tasks/preview", verify_path_escape)
            assert status == 400 and "verification argv" in verify_path_resp["error"]

            # Observation groups preflight every call before dispatch and accept only READ/VERIFY.
            observe = observe_task("observe-read-verify", [
                {"id": "source", "tool": "read_file", "arguments": {"path": str(target)}},
                {"id": "tests", "tool": "run_command", "arguments": {"command": "cargo test", "cwd": str(project)}},
            ])
            status, observe_preview = request(bridge_port, "POST", "/v1/tasks/preview", observe)
            assert status == 200, observe_preview
            op_preview = observe_preview["preview"]["operation"]
            assert op_preview["classification"] == "verify"
            assert [call["classification"] for call in op_preview["calls"]] == ["read_only", "verify"]
            assert observe_preview["preview"]["approval"]["required"] is False
            status, observe_run = request(bridge_port, "POST", "/v1/tasks", observe)
            assert status == 200 and observe_run["result"]["status"] == "ok", observe_run
            assert [call["id"] for call in observe_run["result"]["operation"]["calls"]] == ["source", "tests"]
            assert observe_run["result"]["applied_mutations"] == []

            calls_before_rejected_group = len([c for c in MockMcp.calls if c["method"] == "tools/call"])
            observe_with_write = observe_task("observe-write-rejected", [
                {"id": "source", "tool": "read_file", "arguments": {"path": str(target)}},
                {"id": "write", "tool": "apply_patch", "arguments": {"path": str(target)}},
            ])
            status, rejected_group = request(bridge_port, "POST", "/v1/tasks/preview", observe_with_write)
            # With general writes disabled this fails even earlier at write policy; either way nothing dispatches.
            assert status == 400 and ("write_policy_denied" in rejected_group["error"] or "observe_policy_denied" in rejected_group["error"])
            calls_after_rejected_group = len([c for c in MockMcp.calls if c["method"] == "tools/call"])
            assert calls_after_rejected_group == calls_before_rejected_group

            # Enable ordinary writes, using optimistic registry versioning.
            servers_write = json.loads(json.dumps(servers))
            servers_write["workspace"]["write"] = True
            status, saved = request(bridge_port, "POST", "/v1/servers", {"servers": servers_write, "expected_version": first_version})
            assert status == 200, saved
            second_version = saved["version"]
            status, observe_write_enabled = request(bridge_port, "POST", "/v1/tasks/preview", observe_with_write)
            assert status == 400 and "observe_policy_denied" in observe_write_enabled["error"]

            # RW barrier: an exclusive write cannot interleave between calls of one observation group.
            rw_observe = observe_task("rw-observe", [
                {"id": "slow", "tool": "slow_read", "arguments": {"path": str(target)}},
                {"id": "after", "tool": "read_file", "arguments": {"path": str(target)}},
            ])
            rw_write = task("rw-write", "apply_patch", target)
            status, rw_approval = request(bridge_port, "POST", "/v1/approvals", {
                "task": rw_write, "session_id": "rw-session", "decision": "once"
            })
            assert status == 200 and rw_approval["approval_token"]
            call_mark = len(MockMcp.calls)
            outcomes = {}
            def run_observe():
                outcomes["observe"] = request(bridge_port, "POST", "/v1/tasks", rw_observe)
            def run_write():
                outcomes["write"] = request(bridge_port, "POST", "/v1/tasks", {
                    "task": rw_write, "session_id": "rw-session", "approval_token": rw_approval["approval_token"]
                })
            t_read = threading.Thread(target=run_observe)
            t_write = threading.Thread(target=run_write)
            t_read.start()
            time.sleep(0.05)
            t_write.start()
            t_read.join(timeout=5); t_write.join(timeout=5)
            assert outcomes["observe"][0] == 200 and outcomes["write"][0] == 200, outcomes
            ordered_tools = [c["tool"] for c in MockMcp.calls[call_mark:] if c["method"] == "tools/call"]
            assert ordered_tools[:3] == ["slow_read", "read_file", "apply_patch"], ordered_tools

            status, stale = request(bridge_port, "POST", "/v1/servers", {"servers": servers, "expected_version": first_version})
            assert status == 400 and "server_registry_changed" in stale["error"]

            no_roots = json.loads(json.dumps(servers_write))
            no_roots["workspace"]["roots"] = []
            status, no_roots_saved = request(bridge_port, "POST", "/v1/servers", {
                "servers": no_roots, "expected_version": second_version
            })
            assert status == 200, no_roots_saved
            status, no_roots_denied = request(bridge_port, "POST", "/v1/tasks/preview", task("no-roots", "apply_patch", target))
            assert status == 400 and "no allowed roots" in no_roots_denied["error"]
            status, roots_restored = request(bridge_port, "POST", "/v1/servers", {
                "servers": servers_write, "expected_version": no_roots_saved["version"]
            })
            assert status == 200, roots_restored
            second_version = roots_restored["version"]

            # Root containment is value-based, not dependent on MCP argument vocabulary.
            for index, key_name in enumerate(["filename", "dest", "target", "output", "pcb", "to", "src", "sch"]):
                bypass = task_args(f"path-bypass-{index}", "apply_patch", {key_name: str(outside)})
                status, denied = request(bridge_port, "POST", "/v1/tasks/preview", bypass)
                assert status == 400 and "path_policy_denied" in denied["error"], (key_name, status, denied)
            tilde_bypass = task_args("tilde-path-bypass", "apply_patch", {"filename": "~/secret.txt"})
            status, denied = request(bridge_port, "POST", "/v1/tasks/preview", tilde_bypass)
            assert status == 400 and "path_policy_denied" in denied["error"]
            relative_named = task_args("relative-named-path", "apply_patch", {"path": "src/main.rs"})
            status, denied = request(bridge_port, "POST", "/v1/tasks/preview", relative_named)
            assert status == 400 and "must be an absolute path" in denied["error"]
            nested_bypass = task_args("nested-path-bypass", "apply_patch", {"payload": {"filename": str(outside)}})
            status, denied = request(bridge_port, "POST", "/v1/tasks/preview", nested_bypass)
            assert status == 400 and "path_policy_denied" in denied["error"]
            allowed_unknown_key = task_args("path-weird-allowed", "apply_patch", {"filename": str(target)})
            status, allowed_preview = request(bridge_port, "POST", "/v1/tasks/preview", allowed_unknown_key)
            assert status == 200 and allowed_preview["preview"]["operation"]["path_checks"][0]["root"] == str(project)
            non_path_text = task_args("non-path-text", "apply_patch", {"note": "hello/world", "patch": "diff --git a/x b/x\n+const p = '/etc/passwd';"})
            status, non_path_preview = request(bridge_port, "POST", "/v1/tasks/preview", non_path_text)
            assert status == 200 and non_path_preview["preview"]["operation"]["path_checks"] == []

            write_task = task("write-ok", "apply_patch", target)
            status, write_preview = request(bridge_port, "POST", "/v1/tasks/preview", write_task)
            assert status == 200 and write_preview["preview"]["operation"]["classification"] == "write"
            assert write_preview["preview"]["approval"]["required"] is True
            assert write_preview["preview"]["approval"]["mode"] == "mutations"
            status, unapproved_write = request(bridge_port, "POST", "/v1/tasks", write_task)
            assert status == 400 and "approval_required" in unapproved_write["error"]
            browser_session = "browser-session-1"
            status, approved = request(bridge_port, "POST", "/v1/approvals", {
                "task": write_task, "session_id": browser_session, "decision": "once"
            })
            assert status == 200 and approved["approval_token"]
            # Bad task/session replays must not consume the legitimate approval token.
            wrong_task = task("write-other", "apply_patch", target)
            status, wrong_task_resp = request(bridge_port, "POST", "/v1/tasks", {
                "task": wrong_task, "session_id": browser_session, "approval_token": approved["approval_token"]
            })
            assert status == 400 and "does not match this task" in wrong_task_resp["error"]
            status, wrong_session = request(bridge_port, "POST", "/v1/tasks", {
                "task": write_task, "session_id": "wrong-session", "approval_token": approved["approval_token"]
            })
            assert status == 400 and "does not match this browser session" in wrong_session["error"]
            status, approved_write = request(bridge_port, "POST", "/v1/tasks", {
                "task": write_task, "session_id": browser_session, "approval_token": approved["approval_token"]
            })
            assert status == 200 and approved_write["result"]["status"] == "ok"

            # Policy changes intentionally invalidate a token permanently.
            policy_task = task("policy-token", "apply_patch", target)
            status, policy_approval = request(bridge_port, "POST", "/v1/approvals", {
                "task": policy_task, "session_id": browser_session, "decision": "once"
            })
            assert status == 200 and policy_approval["approval_token"]
            status, reg_now = request(bridge_port, "GET", "/v1/servers")
            changed_policy = reg_now["servers"]
            changed_policy["workspace"]["approval_mode"] = "all"
            status, changed_saved = request(bridge_port, "POST", "/v1/servers", {
                "servers": changed_policy, "expected_version": reg_now["version"]
            })
            assert status == 200, changed_saved
            status, policy_rejected = request(bridge_port, "POST", "/v1/tasks", {
                "task": policy_task, "session_id": browser_session, "approval_token": policy_approval["approval_token"]
            })
            assert status == 400 and "local policy changed after approval" in policy_rejected["error"]
            status, restored = request(bridge_port, "POST", "/v1/servers", {
                "servers": servers_write, "expected_version": changed_saved["version"]
            })
            assert status == 200, restored
            second_version = restored["version"]
            status, consumed_after_policy_change = request(bridge_port, "POST", "/v1/tasks", {
                "task": policy_task, "session_id": browser_session, "approval_token": policy_approval["approval_token"]
            })
            assert status == 400 and "missing, expired, or already used" in consumed_after_policy_change["error"]

            status, destructive = request(bridge_port, "POST", "/v1/tasks/preview", task("destroy", "delete_all", target))
            assert status == 400 and "destructive_policy_denied" in destructive["error"]

            status, run = request(bridge_port, "POST", "/v1/tasks", read_task)
            assert status == 200, run
            assert run["result"]["status"] == "ok"
            assert run["result"]["operation"]["truncated"] is False
            key = run["journal_key"]
            assert key == hashlib.sha256(b"read-1").hexdigest()

            status, replay = request(bridge_port, "POST", "/v1/tasks", read_task)
            assert status == 200 and replay["replayed"] is True
            conflict = task("read-1", "read_file", project / "other.rs")
            status, conflict_resp = request(bridge_port, "POST", "/v1/tasks", conflict)
            assert status == 400 and "different content" in conflict_resp["error"]

            before_files = set(tasks_dir.iterdir())
            missing = dict(read_task); missing.pop("id")
            status, missing_resp = request(bridge_port, "POST", "/v1/tasks", missing)
            assert status == 400 and "task.id" in missing_resp["error"]
            assert set(tasks_dir.iterdir()) == before_files

            # Force one 404 on tools/call; bridge must transparently reinitialize once.
            flaky = task("flaky", "flaky_read", target)
            status, flaky_run = request(bridge_port, "POST", "/v1/tasks", flaky)
            assert status == 200, flaky_run
            assert flaky_run["result"]["status"] == "ok"
            assert MockMcp.session_counter >= 3  # test connection + pooled session + reinit

            # Explicit ambiguous-journal recovery.
            ambiguous_id = "ambiguous"
            amb_key = hashlib.sha256(ambiguous_id.encode()).hexdigest()
            amb_task_path = tasks_dir / f"{amb_key}.task.json"
            amb_task_path.write_text(json.dumps(task(ambiguous_id, "read_file", target)))
            os.chmod(amb_task_path, 0o600)
            status, ambiguous = request(bridge_port, "POST", "/v1/tasks", task(ambiguous_id, "read_file", target))
            assert status == 400 and "ambiguous_task_state" in ambiguous["error"]
            status, recovered = request(bridge_port, "DELETE", f"/v1/tasks/{amb_key}?acknowledge_ambiguous=true")
            assert status == 200 and recovered["recovered"] == amb_key and not amb_task_path.exists()

            # Session mode: first risk level asks, lease covers same/lower risk only.
            status, current_registry = request(bridge_port, "GET", "/v1/servers")
            assert status == 200
            session_servers = current_registry["servers"]
            session_servers["workspace"]["approval_mode"] = "session"
            status, session_saved = request(bridge_port, "POST", "/v1/servers", {
                "servers": session_servers, "expected_version": current_registry["version"]
            })
            assert status == 200, session_saved
            final_version = session_saved["version"]
            session_read = task("session-read-1", "read_file", target)
            status, session_preview = request(bridge_port, "POST", "/v1/tasks/preview", {
                "task": session_read, "session_id": "tab-abc"
            })
            assert status == 200 and session_preview["preview"]["approval"]["required"] is True
            assert session_preview["preview"]["approval"]["session_approval_available"] is True
            status, lease = request(bridge_port, "POST", "/v1/approvals", {
                "task": session_read, "session_id": "tab-abc", "decision": "session"
            })
            assert status == 200 and lease["session_granted"] is True
            assert 0 < lease["session_expires_in_s"] <= 2 * 60 * 60
            status, leased_run = request(bridge_port, "POST", "/v1/tasks", {
                "task": session_read, "session_id": "tab-abc", "approval_token": lease["approval_token"]
            })
            assert status == 200 and leased_run["result"]["status"] == "ok"
            session_read2 = task("session-read-2", "read_file", target)
            status, session_preview2 = request(bridge_port, "POST", "/v1/tasks/preview", {
                "task": session_read2, "session_id": "tab-abc"
            })
            assert status == 200 and session_preview2["preview"]["approval"]["required"] is False
            session_write = task("session-write", "apply_patch", target)
            status, session_write_preview = request(bridge_port, "POST", "/v1/tasks/preview", {
                "task": session_write, "session_id": "tab-abc"
            })
            assert status == 200 and session_write_preview["preview"]["approval"]["required"] is True

            # Policy-only mode auto-authorizes within daemon authority, while destructive can stay gated.
            status, current_registry = request(bridge_port, "GET", "/v1/servers")
            none_servers = current_registry["servers"]
            none_servers["workspace"]["approval_mode"] = "none"
            none_servers["workspace"]["allow_destructive"] = True
            none_servers["workspace"]["always_approve_destructive"] = True
            status, none_saved = request(bridge_port, "POST", "/v1/servers", {
                "servers": none_servers, "expected_version": current_registry["version"]
            })
            assert status == 200, none_saved
            status, none_write_preview = request(bridge_port, "POST", "/v1/tasks/preview", {
                "task": task("none-write", "apply_patch", target), "session_id": "tab-none"
            })
            assert status == 200 and none_write_preview["preview"]["approval"]["required"] is False
            status, destructive_prompt = request(bridge_port, "POST", "/v1/tasks/preview", {
                "task": task("none-destroy", "delete_all", target), "session_id": "tab-none"
            })
            assert status == 200 and destructive_prompt["preview"]["approval"]["required"] is True

            # all mode forces even reads through a one-time approval token.
            status, current_registry = request(bridge_port, "GET", "/v1/servers")
            all_servers = current_registry["servers"]
            all_servers["workspace"]["approval_mode"] = "all"
            status, all_saved = request(bridge_port, "POST", "/v1/servers", {
                "servers": all_servers, "expected_version": current_registry["version"]
            })
            assert status == 200, all_saved
            final_version = all_saved["version"]
            all_read = task("all-read", "read_file", target)
            status, all_preview = request(bridge_port, "POST", "/v1/tasks/preview", {
                "task": all_read, "session_id": "tab-all"
            })
            assert status == 200 and all_preview["preview"]["approval"]["required"] is True
            status, all_unapproved = request(bridge_port, "POST", "/v1/tasks", {
                "task": all_read, "session_id": "tab-all"
            })
            assert status == 400 and "approval_required" in all_unapproved["error"]

            # Security-relevant file modes.
            assert (state.stat().st_mode & 0o777) == 0o700
            assert (tasks_dir.stat().st_mode & 0o777) == 0o700
            for p in tasks_dir.iterdir():
                assert (p.stat().st_mode & 0o777) == 0o600, (p, oct(p.stat().st_mode & 0o777))

            # Confirm current registry version is coherent.
            status, registry2 = request(bridge_port, "GET", "/v1/servers")
            assert status == 200 and registry2["version"] == final_version

            print("smoke_test.py: PASS")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.wait()
            if proc.returncode not in (0, -15):
                print(proc.stdout.read() if proc.stdout else "")
            mcp.shutdown()


if __name__ == "__main__":
    main()
