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
    flaky_write_404_sent = False

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
                {"name": "run_command", "description": "command", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": False, "destructiveHint": True}},
                {"name": "apply_patch", "description": "write", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": False}},
                {"name": "delete_all", "description": "destroy", "inputSchema": {"type": "object"}, "annotations": {"destructiveHint": True}},
                {"name": "failing_patch", "description": "write that reports isError", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": False}},
                {"name": "flaky_write", "description": "write that 404s once", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": False}},
                {"name": "second_patch", "description": "write", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": False}},
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
            if name == "flaky_write" and not MockMcp.flaky_write_404_sent:
                MockMcp.flaky_write_404_sent = True
                self._json(404, {"error": "session expired"})
                return
            if name == "failing_patch":
                self._json(200, {"jsonrpc": "2.0", "id": msg["id"], "result": {
                    "content": [{"type": "text", "text": "failed at hunk 3 of 5"}],
                    "isError": True,
                }})
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
        "version": "1.3",
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
        "version": "1.3",
        "id": task_id,
        "title": "observe smoke",
        "description": "grouped reads and verification",
        "operation": {
            "type": "mcp.observe",
            "server": "workspace",
            "calls": calls,
        },
    }


def planned_task(task_id, plan_item_id, target, include_plan=False):
    value = task(task_id, "read_file", target)
    value["version"] = "1.3"
    value["plan_id"] = "stabilize-v092"
    value["plan_revision"] = 1
    value["plan_item_id"] = plan_item_id
    value["outputs"] = [{
        "id": f"{task_id}-report",
        "label": f"{task_id} report",
        "kind": "report",
        "ref": str(target),
    }]
    if include_plan:
        value["plan"] = {
            "id": "stabilize-v092",
            "revision": 1,
            "title": "Stabilize Local MCP Bridge v0.9.2",
            "items": [
                {"id": "p1", "phase": "plan", "title": "Audit current implementation"},
                {"id": "p2", "phase": "execute", "title": "Update sidebar presentation"},
            ],
            "context": {
                "resources": [{"kind": "workspace", "label": "local-mcp-bridge"}],
                "constraints": ["LBP 1.3"],
            },
        }
    return value


def second_plan_task(task_id, plan_item_id, target, include_plan=False):
    """A different plan, used to prove a later chain may carry its own plan."""
    value = task(task_id, "read_file", target)
    value["version"] = "1.3"
    value["plan_id"] = "followup-plan"
    value["plan_revision"] = 1
    value["plan_item_id"] = plan_item_id
    if include_plan:
        value["plan"] = {
            "id": "followup-plan",
            "revision": 1,
            "title": "Follow-up work",
            "items": [{"id": "q1", "phase": "execute", "title": "Follow-up step"}],
        }
    return value


def run_suite(port, project, target, outside, state_dir):
    def section(name):
        print(f"\n{name}")

    def ok(name):
        PASSED.append(name)
        print(f"  ok  {name}")

    # ---------------------------------------------------------------- protocol
    section("protocol freeze")

    status, health = request(port, "GET", "/health")
    assert status == 200 and health["protocols"][0]["versions"] == ["1.3.1", "1.3", "1.2"], health
    assert set(health["operations"]) == {"mcp.call", "mcp.list_tools", "mcp.observe", "mcp.mutate"}
    ok("daemon advertises LBP 1.3.1, 1.3 and 1.2")

    c = Conversation(port, conv_id("proto")).begin()
    legacy = task("legacy-11", "read_file", target)
    legacy["version"] = "1.1"
    status, body = c.try_act("register_task", assistant_turn_id="a1", task=legacy)
    assert status == 400 and "1.1 is historical" in body["error"], body
    ok("daemon rejects LBP 1.1 rather than coercing it")

    single = task("legacy-single", "read_file", target)
    single["operations"] = [dict(single.pop("operation"), mutating=False, required=True)]
    reg = c.register(single, "a-single")
    assert reg["task_id"] == "legacy-single"
    ok("single-element operations[] normalizes as canonical 1.2")

    v131_task = task("v131-plan", "read_file", target)
    v131_task["version"] = "1.3.1"
    v131_task["plan"] = {
        "id": "v131-plan",
        "revision": 1,
        "title": "LBP 1.3.1 plan",
        "items": [{"id": "step-1", "title": "Read source"}],
        "context": {"resources": [], "constraints": []},
    }
    v131_task["plan_id"] = "v131-plan"
    v131_task["plan_revision"] = 1
    v131_task["plan_item_id"] = "step-1"
    v131_task["outputs"] = [
        {"id": "out-1", "label": "Source read", "kind": "evidence"}
    ]
    v131 = Conversation(port, conv_id("v131-task")).begin()
    reg_v131, (status, run_v131) = v131.run_approved(v131_task, "a-v131")
    assert status == 200, run_v131
    assert run_v131["result"]["version"] == "1.3", run_v131
    assert "body" not in run_v131["result"], run_v131
    assert run_v131["result"]["task_id"] == "v131-plan"
    ok("LBP 1.3.1 tasks accept 1.3 plan/output semantics while legacy results remain labeled 1.3")

    mutate_131 = {
        "protocol": "lbp",
        "version": "1.3.1",
        "id": "v131-mutate",
        "operation": {
            "type": "mcp.mutate",
            "server": "workspace",
            "calls": [{"id": "edit", "tool": "apply_patch", "arguments": {}}],
        },
    }
    mutate_131_conv = Conversation(port, conv_id("v131-mutate")).begin()
    reg_mutate_131 = mutate_131_conv.register(mutate_131, "a-v131-mutate")
    assert reg_mutate_131["task_id"] == "v131-mutate", reg_mutate_131
    mutate_131_conv.act("abandon_task", registration=reg_mutate_131["registration_id"], reason="protocol regression only")

    mutate_12 = dict(mutate_131)
    mutate_12["version"] = "1.2"
    mutate_12["id"] = "v12-mutate"
    mutate_12_conv = Conversation(port, conv_id("v12-mutate")).begin()
    status, body = mutate_12_conv.try_act("register_task", assistant_turn_id="a-v12-mutate", task=mutate_12)
    assert status == 400 and "requires LBP 1.3 or 1.3.1" in body["error"], body
    ok("mcp.mutate accepts 1.3.1 task semantics and still rejects 1.2")

    # ------------------------------------------------------- conversation state
    section("conversation identity and enable baseline")

    c = Conversation(port, conv_id("baseline"))
    c.act("enable")
    c.act("observe_user_turn", turn_id="old-turn-revealed-by-scrolling")
    assert c.state["active_chain"] is None
    status, body = c.try_act("register_task", assistant_turn_id="a-hist", task=task("hist", "read_file", target))
    assert status == 400 and "no active chain" in body["error"], body
    ok("enabling does not make a historical/scrolled-in turn executable")

    c.act("arm_human_send")
    c.act("observe_user_turn", turn_id="u-real")
    assert c.state["phase"] == "awaiting_assistant" and c.state["active_chain"] is not None
    ok("a chain starts only after an armed genuine send produces a turn")

    other = Conversation(port, conv_id("other-chat"))
    assert other.state["enabled"] is False
    assert other.state["active_chain"] is None
    ok("enabling one conversation leaves every other conversation untouched")

    # Disabled is a real off switch. An un-enabled conversation cannot arm a
    # chain, and therefore cannot register or execute local work.
    bare = Conversation(port, conv_id("never-enabled"))
    bare.act("observe_user_turn", turn_id="scrolled-in")
    status, body = bare.try_act("register_task", assistant_turn_id="b-a1", task=task("bare", "read_file", target))
    assert status == 400 and "disabled" in body["error"], body
    ok("a disabled conversation cannot register a task")

    armed = bare.act("arm_human_send")
    assert armed.get("armed") is False
    bare.act("observe_user_turn", turn_id="bare-u1")
    assert bare.state["active_chain"] is None
    ok("a disabled conversation cannot arm or create an executable chain")

    bare.act("enable")
    bare.act("arm_human_send")
    bare.act("observe_user_turn", turn_id="bare-u2")
    reg_bare, (status, run_bare) = bare.run_approved(task("bare-1", "read_file", target), "b-a2")
    assert status == 200 and run_bare["result"]["status"] == "ok", run_bare
    assert run_bare["delivery_id"].startswith("d-") and len(run_bare["result_digest"]) == 64, run_bare
    assert bare.state["enabled"] is True
    ok("Enable is required before an armed chain can execute, and execution returns a delivery binding")

    result_turn = Conversation(port, conv_id("bridge-result-turn")).begin()
    reg_result, (status, run_result) = result_turn.run_approved(
        task("bridge-result-1", "read_file", target), "br-a1"
    )
    assert status == 200, run_result
    chain_id = result_turn.state["active_chain"]["chain_id"]
    result_turn.act("task_execution_status", registration=reg_result, status="completed")
    result_turn.act("task_delivery_status", registration=reg_result, status="inserted")
    result_turn.acknowledge(reg_result, "br-u-result")
    assert result_turn.state["phase"] == "awaiting_assistant"
    result_turn.act("observe_user_turn", turn_id="br-u-result")
    assert result_turn.state["active_chain"]["chain_id"] == chain_id
    assert result_turn.state["active_chain"]["total_task_count"] == 1
    ok("an acknowledged bridge result turn does not start a new human chain")

    # Enable must not throw away a run in progress.
    live = Conversation(port, conv_id("enable-midrun")).begin()
    reg_live = live.register(task("live-1", "read_file", target), "l-a1")["registration_id"]
    chain_before = live.state["active_chain"]["chain_id"]
    live.act("enable")
    assert live.state["active_chain"]["chain_id"] == chain_before, "Enable discarded the running chain"
    assert live.state["current_registration"] == reg_live
    ok("pressing Enable mid-run does not discard the chain")

    # Disable is the real off switch.
    live.act("disable")
    assert live.state["phase"] == "disabled"
    status, body = live.run(reg_live)
    assert status == 400 and "switched off" in body["error"], body
    ok("Disable stops the run and blocks execution")

    p = Conversation(port, prov_id("tab-A")).begin(turn="pu1")
    p_reg = p.register(task("prov-task", "read_file", target), "pa1")
    canonical = conv_id("bound-chat")
    status, bound = request(port, "POST", "/v1/conversation-state/bind",
                            {"provisional_id": p.id, "canonical_id": canonical})
    assert status == 200 and bound["state"]["bound"] is True and bound["state"]["enabled"] is True
    ok("provisional state migrates to a canonical conversation exactly once")

    status, again = request(port, "POST", "/v1/conversation-state/bind",
                            {"provisional_id": prov_id("tab-B"), "canonical_id": canonical})
    assert status == 200 and again["state"]["bound"] is False
    ok("a second tab cannot overwrite existing canonical state")

    bound_conv = Conversation(port, canonical)
    status, preview = bound_conv.preview(p_reg["registration_id"])
    assert status == 200, preview
    ok("a registration survives provisional -> canonical binding")

    # ------------------------------------------------------------- concurrency
    section("concurrency and ownership")

    c = Conversation(port, conv_id("cas")).begin()
    stale = c.state["revision"]
    c.act("observe_assistant_turn", turn_id="a1")
    status, body = c.try_act("observe_assistant_turn", turn_id="a2", expected_revision=stale)
    assert status == 409 and body["state"]["revision"] > stale, body
    ok("a stale revision is rejected with the current state for merge")

    c.act("claim_owner", tab_token="tab-one")
    status, body = c.try_act("observe_assistant_turn", turn_id="a3", tab_token="tab-two")
    assert status == 400 and "not_owner" in body["error"], body
    ok("a second tab cannot drive a conversation another tab owns")

    # The lease guards the actions that DRIVE the pump. It must never block a
    # human's own click: blocking `configure` locked people out of the
    # Auto-continue toggle in their own tab and left the sidebar and the
    # settings page disagreeing about the mode.
    status, body = c.try_act("configure", mode="manual", checkpoint_size=12, tab_token="tab-two")
    assert status == 200, body
    assert body["state"]["mode"] == "manual", body["state"]
    ok("a non-owner tab can still change settings the human asked for")

    for human_action, payload in (("enable", {}), ("stop", {}), ("disable", {})):
        status, body = c.try_act(human_action, tab_token="tab-two", **payload)
        assert status == 200, (human_action, body)
    ok("enable, stop and disable are never blocked by the owner lease")

    # A reloaded tab is the live tab and takes the lease, rather than waiting it
    # out -- otherwise reloading locked the user out for the whole lease window.
    status, body = c.try_act("claim_owner", tab_token="tab-three")
    assert status == 200 and body["state"]["owner_granted"] is False, body
    status, body = c.try_act("claim_owner", tab_token="tab-three", takeover=True)
    assert status == 200 and body["state"]["owner_granted"] is True, body
    c.act("enable", tab_token="tab-three")
    status, body = c.try_act("observe_assistant_turn", turn_id="a4", tab_token="tab-three")
    assert status == 200, body
    ok("a reloaded tab takes the lease instead of waiting for it to expire")

    # -------------------------------------------------------------- journaling
    section("task registration and journaling")

    a = Conversation(port, conv_id("chat-A")).begin()
    b = Conversation(port, conv_id("chat-B")).begin()
    reg_a, (status, run_a) = a.run_approved(task("task1", "read_file", target))
    assert status == 200 and run_a["result"]["status"] == "ok"
    reg_b = b.register(task("task1", "read_file", target))["registration_id"]
    status, run_b = b.run(reg_b)
    assert status == 200 and run_b["replayed"] is False
    assert run_b["journal_key"] != run_a["journal_key"]
    ok("the same task id in two conversations is fully isolated")

    same = a.register(task("task1", "read_file", target))
    assert same["registration_id"] == reg_a
    ok("re-registering the same task id and digest re-attaches to the same handle")

    # Replay the coordinator's REAL call order. The suite used to skip straight
    # from register to run, so it never caught that reporting "running" before
    # dispatch made the daemon refuse to execute -- every task in the browser
    # died with "task is not executable from status 'running'" while the tests
    # stayed green.
    seq = Conversation(port, conv_id("coordinator-order")).begin()
    reg_seq = seq.register(task("seq-1", "read_file", target), "seq-a1")["registration_id"]
    status, preview = seq.preview(reg_seq)
    assert status == 200, preview
    seq.act("task_execution_status", registration=reg_seq, status="running")
    status, run_seq = seq.run(reg_seq)
    assert status == 200 and run_seq["result"]["status"] == "ok", run_seq
    ok("a task still executes after the browser has reported it as running")

    # Only a dispatched task is unsafe to run again.
    with_dispatch = Conversation(port, conv_id("dispatched-guard")).begin()
    reg_d = with_dispatch.register(task("dispatch-1", "read_file", target), "d-a1")["registration_id"]
    key = hashlib.sha256(
        with_dispatch.id.encode() + b"\x00" + b"dispatch-1"
    ).hexdigest()
    journal = pathlib.Path(str(state_dir / "tasks" / f"{key}.journal.json"))
    record = json.loads(journal.read_text())
    record["execution_status"] = "executing"
    journal.write_text(json.dumps(record))
    status, body = with_dispatch.run(reg_d)
    assert status == 400 and "ambiguous_task_state" in body["error"], body
    ok("a task that actually dispatched is still refused as ambiguous")

    conflicting = task("task1", "read_file", outside)
    status, body = a.try_act("register_task", assistant_turn_id="a1", task=conflicting)
    assert status == 400 and "different content" in body["error"], body
    ok("the same task id with a different digest is refused")

    status, replay = a.run(reg_a)
    assert status == 200 and replay["replayed"] is True
    ok("a completed task replays its stored result without re-entering MCP")

    # --------------------------------------------------------------- plan model
    section("LBP 1.3 plan, outputs and context")

    plan_conv = Conversation(port, conv_id("plan-model")).begin()
    reg_p1, (status, run_p1) = plan_conv.run_approved(
        planned_task("plan-task-1", "p1", target, include_plan=True), "plan-a1"
    )
    assert status == 200 and plan_conv.state["plan"]["items"][0]["status"] == "current"
    plan_conv.act("task_execution_status", registration=reg_p1, status="completed")
    assert plan_conv.state["plan"]["items"][0]["status"] == "completed"
    assert plan_conv.state["outputs"][0]["status"] == "produced"
    assert plan_conv.state["context"]["constraints"][0] == "LBP 1.3"
    ok("a first planned task registers an immutable plan, context and pending output")

    context_conv = Conversation(port, conv_id("context-sources")).begin()
    context_conv.act("add_context_source", kind="folder", path=str(project))
    user_sources = [item for item in context_conv.state["context"]["sources"] if item.get("origin") == "user"]
    assert len(user_sources) == 1, context_conv.state["context"]
    assert user_sources[0]["path"] == str(project.resolve(strict=False))
    assert user_sources[0]["server"] == "workspace"
    assert user_sources[0]["accessible"] is True
    status, workspace_sources = request(port, "GET", "/v1/context/workspaces")
    assert status == 200 and workspace_sources["sources"][0]["path"] == str(project.resolve(strict=False))
    assert "endpoint" not in json.dumps(workspace_sources), workspace_sources
    status, body = context_conv.try_act("add_context_source", kind="folder", path=str(outside.parent / "other"))
    assert status == 400 and "outside the currently allowed MCP roots" in body["error"], body
    context_conv.act("remove_context_source", source_id=user_sources[0]["id"])
    remaining = [item for item in context_conv.state["context"]["sources"] if item.get("origin") == "user"]
    assert remaining == []
    ok("conversation Context sources are daemon-owned, root-validated and removable without changing MCP policy")

    plan_conv.act("task_delivery_status", registration=reg_p1, status="inserted")
    plan_conv.acknowledge(reg_p1, "plan-ack1")
    reg_p2 = plan_conv.register(planned_task("plan-task-2", "p2", target), "plan-a2")
    assert reg_p2["plan_item_id"] == "p2"
    assert plan_conv.state["plan"]["items"][1]["status"] == "current"
    ok("the next plan item can register only after the prior item completes and is acknowledged")

    bad_plan = Conversation(port, conv_id("plan-order")).begin()
    status, body = bad_plan.try_act(
        "register_task",
        assistant_turn_id="bad-plan-a1",
        task=planned_task("bad-plan-2", "p2", target, include_plan=True),
    )
    assert status == 400 and "plan order violation" in body["error"], body
    ok("a planned task cannot skip ahead of daemon-persisted plan order")

    dup_plan = planned_task("dup-plan", "p1", target, include_plan=True)
    dup_plan["plan"]["items"].append({"id": "p1", "phase": "execute", "title": "Duplicate"})
    status, body = Conversation(port, conv_id("plan-dupe")).begin().try_act(
        "register_task", assistant_turn_id="dup-plan-a1", task=dup_plan
    )
    assert status == 400 and "not unique" in body["error"], body
    ok("plan item ids must be unique")

    # A plan is immutable once registered FOR A CHAIN. Before this was
    # chain-scoped, the first plan in a conversation blocked every later one
    # permanently: a new plan raised "immutable after execution has begun" and
    # the old plan's remaining items raised "superseded chain", so the whole
    # plan feature wedged after a single use.
    second = Conversation(port, conv_id("plan-second-chain")).begin()
    reg_s1, (status, run_s1) = second.run_approved(
        planned_task("second-1", "p1", target, include_plan=True), "second-a1"
    )
    assert status == 200, run_s1
    second.act("task_execution_status", registration=reg_s1, status="completed")
    second.act("task_delivery_status", registration=reg_s1, status="inserted")
    second.acknowledge(reg_s1, "second-ack1")

    second.act("arm_human_send")
    second.act("observe_user_turn", turn_id="second-u2")
    reg_s2 = second.register(second_plan_task("second-2", "q1", target, include_plan=True), "second-a2")
    assert second.state["plan"]["id"] == "followup-plan", second.state["plan"]
    assert second.state["plan"]["items"][0]["status"] == "current"
    ok("a new human turn may register a new plan; one plan does not wedge the conversation")

    # The superseded plan's own items must still be unreachable.
    stale_plan = Conversation(port, conv_id("plan-superseded")).begin()
    reg_t1, (status, run_t1) = stale_plan.run_approved(
        planned_task("stale-plan-1", "p1", target, include_plan=True), "stale-a1"
    )
    assert status == 200, run_t1
    stale_plan.act("task_execution_status", registration=reg_t1, status="completed")
    stale_plan.act("task_delivery_status", registration=reg_t1, status="inserted")
    stale_plan.acknowledge(reg_t1, "stale-ack1")
    stale_plan.act("arm_human_send")
    stale_plan.act("observe_user_turn", turn_id="stale-u2")
    status, body = stale_plan.try_act(
        "register_task", assistant_turn_id="stale-a2",
        task=planned_task("stale-plan-2", "p2", target),
    )
    assert status == 400 and "superseded chain" in body["error"], body
    ok("a plan item from a superseded chain still cannot execute")

    # An already-registered plan is still immutable WITHIN its own chain.
    same_chain = Conversation(port, conv_id("plan-same-chain")).begin()
    reg_c1, (status, run_c1) = same_chain.run_approved(
        planned_task("same-1", "p1", target, include_plan=True), "same-a1"
    )
    assert status == 200, run_c1
    same_chain.act("task_execution_status", registration=reg_c1, status="completed")
    same_chain.act("task_delivery_status", registration=reg_c1, status="inserted")
    same_chain.acknowledge(reg_c1, "same-ack1")
    status, body = same_chain.try_act(
        "register_task", assistant_turn_id="same-a2",
        task=second_plan_task("same-2", "q1", target, include_plan=True),
    )
    assert status == 400 and "immutable" in body["error"], body
    ok("a plan cannot be swapped mid-chain")

    # replay must re-evaluate policy, not just return the journal
    frozen = Conversation(port, conv_id("policy-replay")).begin()
    reg_f, (status, _) = frozen.run_approved(task("policy-replay-1", "read_file", target))
    status, servers_now = request(port, "GET", "/v1/servers")
    shrunk = json.loads(json.dumps(servers_now["servers"]))
    shrunk["workspace"]["allowed_tools"] = ["delete_all"]
    status, saved = request(port, "POST", "/v1/servers",
                            {"servers": shrunk, "expected_version": servers_now["version"]})
    assert status == 200, saved
    status, denied = frozen.run(reg_f)
    assert status == 400 and "tool_policy_denied" in denied["error"], denied
    ok("replay re-evaluates policy: a since-disallowed tool cannot replay")

    restored = json.loads(json.dumps(servers_now["servers"]))
    status, back = request(port, "POST", "/v1/servers",
                           {"servers": restored, "expected_version": saved["version"]})
    assert status == 200, back

    # --------------------------------------------------------- stale execution
    section("stale execution barrier")

    s = Conversation(port, conv_id("stale")).begin()
    reg_old = s.register(task("stale-1", "read_file", target), "a1")["registration_id"]
    s.act("abandon_task", registration=reg_old, reason="denied_by_user")
    s.act("arm_human_send")
    s.act("observe_user_turn", turn_id="u2")
    status, body = s.run(reg_old)
    assert status == 400 and "stale_task" in body["error"], body
    ok("a task from a superseded chain cannot execute")

    status, body = s.preview(reg_old)
    assert status == 400 and "stale_task" in body["error"], body
    ok("a stale task cannot even be previewed")

    s.act("stop", reason="user_stop")
    reg_new = None
    status, body = s.try_act("register_task", assistant_turn_id="a9", task=task("after-stop", "read_file", target))
    assert status == 400, body
    ok("Stop prevents any further registration")

    # ------------------------------------------------------------- checkpoints
    section("checkpoint and approval windows")

    k = Conversation(port, conv_id("checkpoint")).begin(checkpoint_size=2)
    results = []
    for index in (1, 2):
        reg, (status, run) = k.run_approved(task(f"cp-{index}", "read_file", target), f"a{index}")
        assert status == 200, run
        results.append((reg, run["result"]))
        k.act("task_execution_status", registration=reg, status="completed")
        if index == 1:
            k.act("task_delivery_status", registration=reg, status="inserted")
            k.acknowledge(reg, f"ack{index}")
    assert k.state["phase"] == "result_ready", k.state["phase"]
    assert k.state["active_chain"]["window"] == 0
    assert k.state["active_chain"]["window_task_count"] == 2
    ok("filling the window never creates a hard checkpoint pause")

    status, body = k.try_act("register_task", assistant_turn_id="a3", task=task("cp-3", "read_file", target))
    assert status == 400, body
    ok("no new task registers while the final result is still awaiting provider-confirmed delivery")

    reg2, result2 = results[1]
    k.act("task_delivery_status", registration=reg2, status="inserted")
    k.acknowledge(reg2, "ack2")
    assert k.state["phase"] == "awaiting_assistant", k.state["phase"]
    assert k.state["active_chain"]["window"] == 1
    assert k.state["active_chain"]["window_task_count"] == 0
    ok("the full window rolls automatically only after provider-confirmed result submission")

    status, body = k.try_acknowledge(reg2, "ack2")
    assert status == 200 and k.state["active_chain"]["window"] == 1
    ok("a repeated acknowledgement cannot advance the window twice")

    status, body = k.try_act("acknowledge_submission", registration=reg2, turn_id="ack-missing-delivery")
    assert status == 400 and "requires delivery_id" in body["error"], body
    ok("a provider turn cannot be acknowledged without a delivery id")

    status, body = k.try_acknowledge(reg2, "ack-forged", delivery_id="d-forged")
    assert status == 400 and "delivery_id does not match" in body["error"], body
    ok("a forged delivery marker cannot be acknowledged even with the right task id")

    resize = Conversation(port, conv_id("checkpoint-resize")).begin(checkpoint_size=4)
    for index in (1, 2):
        reg_rz, (status, run_rz) = resize.run_approved(
            task(f"resize-{index}", "read_file", target), f"rz-a{index}"
        )
        assert status == 200, run_rz
        resize.act("task_execution_status", registration=reg_rz, status="completed")
        resize.act("task_delivery_status", registration=reg_rz, status="inserted")
        resize.acknowledge(reg_rz, f"rz-ack-{index}")
    assert resize.state["active_chain"]["window"] == 0
    assert resize.state["active_chain"]["window_task_count"] == 2
    assert resize.state["active_chain"]["window_limit"] == 4

    resize.act("configure", checkpoint_size=1, unknown_recovery="auto_continue")
    assert resize.state["checkpoint_size"] == 1
    assert resize.state["unknown_recovery"] == "auto_continue"
    assert resize.state["active_chain"]["window"] == 0
    assert resize.state["active_chain"]["window_task_count"] == 2
    assert resize.state["active_chain"]["window_limit"] == 1
    ok("shrinking checkpoint size changes the next boundary without retroactive rollover")

    reg_rz3, (status, run_rz3) = resize.run_approved(task("resize-3", "read_file", target), "rz-a3")
    assert status == 200, run_rz3
    resize.act("task_execution_status", registration=reg_rz3, status="completed")
    resize.act("task_delivery_status", registration=reg_rz3, status="inserted")
    resize.acknowledge(reg_rz3, "rz-ack-3")
    assert resize.state["active_chain"]["window"] == 1
    assert resize.state["active_chain"]["window_task_count"] == 0
    assert resize.state["active_chain"]["window_limit"] == 1
    ok("a shrunken checkpoint rolls at the next provider-confirmed task boundary")

    resize.act("configure", checkpoint_size=20)
    assert resize.state["active_chain"]["window_limit"] == 20
    assert resize.state["unknown_recovery"] == "auto_continue"
    ok("growing checkpoint size applies immediately and preserves unknown recovery")

    status, body = resize.try_act("configure", unknown_recovery="invalid")
    assert status == 400 and "unknown_recovery must be manual or auto_continue" in body["error"], body
    ok("unknown recovery accepts only manual or auto_continue")

    # -------------------------------------------------------- wedge resistance
    section("wedge resistance")

    w = Conversation(port, conv_id("wedge")).begin(checkpoint_size=3)
    reg_w = w.register(task("wedge-1", "read_file", target), "a1")["registration_id"]
    assert w.state["phase"] == "task_registered"
    w.act("abandon_task", registration=reg_w, reason="denied_by_user")
    assert w.state["phase"] == "awaiting_assistant"
    assert w.state["active_chain"]["window_task_count"] == 1
    ok("an abandoned task keeps its checkpoint slot and the chain stays usable")

    reg_w2 = w.register(task("wedge-2", "read_file", target), "a2")["registration_id"]
    assert reg_w2 != reg_w
    ok("a new task registers after an abandoned one")

    w.act("abandon_task", registration=reg_w2, reason="denied_by_user")
    reg_w3 = w.register(task("wedge-3", "read_file", target), "a3")["registration_id"]
    w.act("abandon_task", registration=reg_w3, reason="denied_by_user")
    assert w.state["phase"] == "awaiting_assistant"
    assert w.state["active_chain"]["window"] == 1
    assert w.state["active_chain"]["window_task_count"] == 0
    ok("an abandoned task that fills the window rolls automatically without a hard checkpoint")

    reg_w4 = w.register(task("wedge-4", "read_file", target), "a4")["registration_id"]
    status, body = w.try_act("task_execution_status", registration=reg_w4, status="totally-made-up")
    assert status == 400 and "execution status must be one of" in body["error"], body
    ok("task status transitions are enum-validated")

    status, body = w.try_act("task_delivery_status", registration=reg_w2, status="submitted")
    assert status == 400, body
    ok("delivery cannot be marked submitted except by acknowledge_submission")

    # ------------------------------------------------------------- approvals
    section("approval scopes")

    ap = Conversation(port, conv_id("approvals")).begin()
    reg = ap.register(task("ap-1", "apply_patch", target), "a1")["registration_id"]
    status, preview = ap.preview(reg)
    assert preview["preview"]["approval"]["required"] is True
    assert preview["preview"]["operation"]["classification"] == "write"
    ok("a write requires approval under approval_mode=mutations")

    status, approval = ap.approve(reg, "once")
    token = approval["approval_token"]
    status, first = ap.run(reg, token)
    assert status == 200 and first["result"]["status"] == "ok"
    ok("a one-time approval executes the exact registered task")

    ap2 = Conversation(port, conv_id("approvals-2")).begin()
    reg2 = ap2.register(task("ap-2", "apply_patch", target), "a1")["registration_id"]
    status, body = ap2.run(reg2, token)
    assert status == 400 and "approval" in body["error"], body
    ok("a spent one-time token cannot authorize another task")

    d = Conversation(port, conv_id("destructive")).begin()
    reg_d = d.register(task("destroy-1", "delete_all", target), "a1")["registration_id"]
    status, preview = d.preview(reg_d)
    approval = preview["preview"]["approval"]
    assert approval["required"] is True and approval["reason"] == "destructive_always"
    assert approval["chain_approval_available"] is False
    assert approval["session_approval_available"] is False
    ok("the destructive hard gate is independent of every lease")

    ch = Conversation(port, conv_id("chain-scope")).begin(checkpoint_size=1)
    reg_c1 = ch.register(task("cs-1", "apply_patch", target), "a1")["registration_id"]
    status, approval = ch.approve(reg_c1, "chain")
    assert status == 200 and approval["chain_granted"] is True, approval
    status, run_c1 = ch.run(reg_c1)
    assert status == 200, run_c1
    ch.act("task_execution_status", registration=reg_c1, status="completed")
    ch.act("task_delivery_status", registration=reg_c1, status="inserted")
    ch.acknowledge(reg_c1, "cack1")
    assert ch.state["active_chain"]["window"] == 1
    reg_c2 = ch.register(task("cs-2", "apply_patch", target), "a2")["registration_id"]
    status, preview2 = ch.preview(reg_c2)
    assert preview2["preview"]["approval"]["required"] is True, preview2
    ok("a chain approval from window 0 does not authorize window 1")

    # ------------------------------------------------- mutation ambiguity
    section("mutation ambiguity")

    m = Conversation(port, conv_id("mutation")).begin()
    reg_m = m.register(task("mut-iserror", "failing_patch", target), "a1")["registration_id"]
    status, approval = m.approve(reg_m, "once")
    status, run_m = m.run(reg_m, approval["approval_token"])
    assert status == 200 and run_m["result"]["status"] == "unknown", run_m["result"]
    assert run_m["result"]["operation"]["execution_state"] == "unknown"
    ok("a mutating tool reporting isError is unknown, never a retryable error")

    assert m.state["phase"] != "stopped"
    m.act("task_execution_status", registration=reg_m, status="unknown")
    assert m.state["phase"] == "stopped" and m.state["stopped_reason"] == "unknown_mutation_state"
    ok("an unknown mutation stops the chain immediately, never waits at a checkpoint")

    m.act("acknowledge_unknown", registration=reg_m)
    unknown_row = next(item for item in m.state["recent_tasks"] if item["registration_id"] == reg_m)
    assert m.state["phase"] == "awaiting_assistant"
    assert m.state["current_registration"] is None
    assert unknown_row["execution_status"] == "unknown"
    assert unknown_row.get("unknown_acknowledged_at")
    ok("acknowledging an unknown resumes the chain without changing or retrying the unknown task")

    m2 = Conversation(port, conv_id("mutation-404")).begin()
    reg_m2 = m2.register(task("mut-404", "flaky_write", target), "a1")["registration_id"]
    status, approval = m2.approve(reg_m2, "once")
    before = len([c for c in MockMcp.calls if c.get("tool") == "flaky_write"])
    status, run_m2 = m2.run(reg_m2, approval["approval_token"])
    after = len([c for c in MockMcp.calls if c.get("tool") == "flaky_write"])
    assert run_m2["result"]["status"] == "unknown", run_m2["result"]
    assert after - before == 1, f"mutating call was re-dispatched after 404 ({after - before} calls)"
    ok("a mutating call is never transparently retried after a session 404")

    r = Conversation(port, conv_id("read-404")).begin()
    reg_r, (status, run_r) = r.run_approved(task("read-404", "flaky_read", target), "a1")
    assert status == 200 and run_r["result"]["status"] == "ok"
    ok("a READ call still recovers transparently from a session 404")

    mb = Conversation(port, conv_id("mutate-batch")).begin()
    batch = mutate_task("batch-1", [
        {"id": "a", "tool": "apply_patch", "arguments": {"path": str(target)}},
        {"id": "b", "tool": "failing_patch", "arguments": {"path": str(target)}},
        {"id": "c", "tool": "second_patch", "arguments": {"path": str(target)}},
    ])
    reg_mb = mb.register(batch, "a1")["registration_id"]
    status, approval = mb.approve(reg_mb, "once")
    status, run_mb = mb.run(reg_mb, approval["approval_token"])
    operation = run_mb["result"]["operation"]
    assert run_mb["result"]["status"] == "unknown", run_mb["result"]["status"]
    assert operation["applied_calls"] == 1 and operation["partial_execution"] is True
    assert operation["calls"][2]["status"] == "skipped"
    assert operation["calls"][2]["execution_state"] == "not_attempted"
    ok("a partially applied mutate batch is unknown and stops at the first failure")

    o = Conversation(port, conv_id("observe")).begin()
    obs = observe_task("obs-1", [
        {"id": "r1", "tool": "read_file", "arguments": {"path": str(target)}},
        {"id": "v1", "tool": "run_command", "arguments": {"command": "cargo test", "cwd": str(project)}},
    ])
    reg_o, (status, run_o) = o.run_approved(obs, "a1")
    assert status == 200 and run_o["result"]["status"] == "ok", run_o
    assert run_o["result"]["operation"]["classification"] == "verify"
    ok("an observe group runs read+verify under one shared barrier")

    bad_observe = observe_task("obs-bad", [
        {"id": "w1", "tool": "apply_patch", "arguments": {"path": str(target)}},
    ])
    ob = Conversation(port, conv_id("observe-bad")).begin()
    reg_ob = ob.register(bad_observe, "a1")["registration_id"]
    status, body = ob.preview(reg_ob)
    assert status == 400 and "observe_policy_denied" in body["error"], body
    ok("a write inside mcp.observe is rejected before dispatch")

    # ------------------------------------------------------------ path policy
    section("path and tool policy")

    pp = Conversation(port, conv_id("paths")).begin()

    def denied(task_id, arguments, fragment, turn):
        reg = pp.register(task_args(task_id, "apply_patch", arguments), turn)["registration_id"]
        status, body = pp.preview(reg)
        assert status == 400 and fragment in body["error"], (task_id, body)
        pp.act("abandon_task", registration=reg, reason="test")

    denied("p1", {"path": str(outside)}, "path_policy_denied", "t1")
    ok("an absolute path outside the configured roots is denied")

    denied("p2", {"filename": str(outside)}, "path_policy_denied", "t2")
    ok("an absolute path in an unrecognized key is still denied")

    denied("p3", {"filename": "../../../../etc/passwd"}, "path_policy_denied", "t3")
    ok("a traversal-shaped relative value in an unrecognized key fails closed")

    denied("p4", {"path": "src/main.rs"}, "path_policy_denied", "t4")
    ok("a relative value in a recognized path key fails closed")

    denied("p5", {"payload": {"filename": str(outside)}}, "path_policy_denied", "t5")
    ok("a nested path argument is still checked")

    reg = pp.register(task_args("p6", "apply_patch", {
        "path": str(target), "note": "hello/world", "branch": "feature/x",
    }), "t6")["registration_id"]
    status, preview = pp.preview(reg)
    assert status == 200, preview
    pp.act("abandon_task", registration=reg, reason="test")
    ok("ordinary slash-bearing text is not mistaken for a path")

    v = Conversation(port, conv_id("verify")).begin()
    reg_v = v.register(task_args("v-1", "run_command", {
        "command": "cargo test --manifest-path ../../outside/Cargo.toml", "cwd": str(project),
    }), "a1")["registration_id"]
    status, body = v.preview(reg_v)
    assert status == 400 and "path_policy_denied" in body["error"], body
    ok("a VERIFY argv path escaping the roots is denied")

    v2 = Conversation(port, conv_id("verify-2")).begin()
    reg_v2 = v2.register(task_args("v-2", "run_command", {
        "command": "rm -rf /; cargo test", "cwd": str(project),
    }), "a1")["registration_id"]
    status, preview = v2.preview(reg_v2)
    assert status == 200, preview
    # Shell control operators fail closed by refusing the VERIFY downgrade: the
    # command keeps the server's destructive classification and therefore stays
    # behind the independent destructive gate. It is never silently treated as a
    # narrow verification command.
    assert preview["preview"]["operation"]["classification"] == "destructive", preview
    assert "verification" not in preview["preview"]["operation"]
    assert preview["preview"]["approval"]["reason"] == "destructive_always"
    ok("shell metacharacters refuse the VERIFY downgrade and stay destructive")

    # -------------------------------------------------------------- transport
    section("transport and auth")

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", "/health", headers={"Authorization": "Bearer wrong", "Host": f"127.0.0.1:{port}"})
    assert conn.getresponse().status == 401
    conn.close()
    ok("a wrong bearer token is rejected")

    status, _ = request(port, "GET", "/health", host="evil.example")
    assert status == 421, status
    ok("a non-loopback Host header is rejected (421 Misdirected Request)")

    status, body = request(port, "POST", "/v1/conversation-state",
                           {"conversation_id": "chat-2a0c975e", "action": "get"})
    assert status == 400 and "conv-" in body["error"], body
    ok("a legacy FNV-style conversation id is no longer a valid identity")
# --- Test harness -------------------------------------------------------------

PASSED = []


def check(name):
    def decorate(fn):
        PASSED.append((name, fn))
        return fn
    return decorate


def conv_id(seed: str) -> str:
    return "conv-" + hashlib.sha256(seed.encode()).hexdigest()[:32]


def prov_id(seed: str) -> str:
    return "prov-" + hashlib.sha256(seed.encode()).hexdigest()[:32]


class Conversation:
    """Drives one conversation through the daemon exactly as the coordinator does."""

    def __init__(self, port: int, conversation_id: str, session_id: str = "tab-1"):
        self.port = port
        self.id = conversation_id
        self.session_id = session_id
        self.state = self.act("get")

    def act(self, action, **payload):
        status, body = request(self.port, "POST", "/v1/conversation-state", {
            "conversation_id": self.id, "action": action, "payload": payload,
        })
        if status != 200:
            raise AssertionError(f"{action} -> {status} {body.get('error')}")
        self.state = body["state"]
        return self.state

    def try_act(self, action, **payload):
        status, body = request(self.port, "POST", "/v1/conversation-state", {
            "conversation_id": self.id, "action": action, "payload": payload,
        })
        if status == 200:
            self.state = body["state"]
        return status, body

    def begin(self, mode="auto_continue", checkpoint_size=12, turn="u1"):
        self.act("enable")
        self.act("configure", mode=mode, checkpoint_size=checkpoint_size)
        self.act("arm_human_send")
        self.act("observe_user_turn", turn_id=turn)
        return self

    def register(self, task_body, assistant_turn_id="a1"):
        state = self.act("register_task", assistant_turn_id=assistant_turn_id, task=task_body)
        return state["task"]

    def preview(self, registration):
        return request(self.port, "POST", "/v1/tasks/preview", {
            "conversation_id": self.id, "registration": registration, "session_id": self.session_id,
        })

    def approve(self, registration, decision):
        return request(self.port, "POST", "/v1/approvals", {
            "conversation_id": self.id, "registration": registration,
            "session_id": self.session_id, "decision": decision,
        })

    def run(self, registration, approval_token=None):
        return request(self.port, "POST", "/v1/tasks", {
            "conversation_id": self.id, "registration": registration,
            "session_id": self.session_id, "approval_token": approval_token,
        })

    def run_approved(self, task_body, assistant_turn_id="a1"):
        """register -> preview -> approve if needed -> run."""
        reg = self.register(task_body, assistant_turn_id)["registration_id"]
        status, preview = self.preview(reg)
        assert status == 200, preview
        token = None
        if preview["preview"]["approval"]["required"]:
            status, approval = self.approve(reg, "once")
            assert status == 200, approval
            token = approval["approval_token"]
        return reg, self.run(reg, token)

    def delivery_for(self, registration):
        for item in reversed(self.state.get("recent_tasks", [])):
            if item.get("registration_id") == registration:
                delivery_id = item.get("delivery_id")
                result_digest = item.get("result_digest")
                assert delivery_id and result_digest, item
                return {"delivery_id": delivery_id, "result_digest": result_digest}
        raise AssertionError(f"missing delivery metadata for {registration}")

    def acknowledge(self, registration, turn_id, **extra):
        payload = {**self.delivery_for(registration), **extra}
        self.act("observe_submission", registration=registration, turn_id=turn_id, **payload)
        return self.act("acknowledge_submission", registration=registration, turn_id=turn_id, **payload)

    def try_acknowledge(self, registration, turn_id, **extra):
        payload = {**self.delivery_for(registration), **extra}
        return self.try_act("acknowledge_submission", registration=registration, turn_id=turn_id, **payload)

    def deliver(self, reg, result, turn_id):
        self.act("task_execution_status", registration=reg,
                 status={"ok": "completed", "unknown": "unknown"}.get(result["status"], "error"))
        self.act("task_delivery_status", registration=reg, status="inserted")
        return self.try_acknowledge(reg, turn_id)


def mutate_task(task_id, calls):
    return {
        "protocol": "lbp", "version": "1.3", "id": task_id, "title": "mutate smoke",
        "operation": {"type": "mcp.mutate", "server": "workspace", "calls": calls},
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
        (state / "tasks").mkdir(parents=True)
        (state / "conversations").mkdir(parents=True)
        (state / "token").write_text(TOKEN + "\n")
        os.chmod(state / "token", 0o600)
        servers = {
            "workspace": {
                "transport": "http",
                "endpoint": f"http://127.0.0.1:{mcp_port}/mcp",
                "timeout_s": 5,
                "enabled": True,
                "allowed_tools": [
                    "read_file", "flaky_read", "slow_read", "run_command",
                    "apply_patch", "delete_all", "failing_patch", "flaky_write", "second_patch",
                ],
                "allow_verify": True,
                "verification_rules": [{
                    "tool": "run_command", "argument": "command",
                    "argv_prefixes": [["cargo", "test"], ["cargo", "check"]],
                }],
                "write": True,
                "allow_destructive": True,
                "roots": [str(project)],
            }
        }
        (state / "servers.json").write_text(json.dumps(servers))
        os.chmod(state / "servers.json", 0o600)

        env = os.environ.copy()
        env["HOME"] = str(home)
        env["LOCAL_MCP_BRIDGE_PORT"] = str(bridge_port)
        proc = subprocess.Popen(["python3", str(ROOT / "daemon.py")], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, text=True)
        try:
            wait_health(bridge_port)
            run_suite(bridge_port, project, target, outside, state)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            mcp.shutdown()

    print(f"\nsmoke test: {len(PASSED)} checks passed\n")


if __name__ == "__main__":
    main()
