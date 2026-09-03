globalThis.LBP = (() => {
  const ENVELOPES = [
    { start: "<LBP_TASK>", end: "</LBP_TASK>", legacy: false },
    { start: "<LBP_TASK_V1>", end: "</LBP_TASK_V1>", legacy: true },
    { start: "<ATLAS_TASK_V1>", end: "</ATLAS_TASK_V1>", legacy: true }
  ];
  const RESULT_ENVELOPE = { start: "<LBP_RESULT>", end: "</LBP_RESULT>" };
  const MAX_OBSERVE_CALLS = 8;

  function normalizeCall(raw, requireId = false) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("MCP call must be a JSON object");
    }
    for (const key of ["mutating", "required", "classification"]) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        throw new Error("LBP derives classification and authority locally");
      }
    }
    if (typeof raw.tool !== "string" || !raw.tool) throw new Error("MCP call tool is required");
    const args = raw.arguments === undefined ? {} : raw.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("MCP call arguments must be an object");
    const value = { tool: raw.tool, arguments: args };
    if (requireId) {
      if (typeof raw.id !== "string" || !raw.id.trim()) throw new Error("mcp.observe calls require an id");
      value.id = raw.id.trim();
    }
    if (typeof raw.description === "string") value.description = raw.description;
    return value;
  }

  function normalizeOperation(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("task operation must be a JSON object");
    }
    const op = { ...raw };
    if (op.type === "mcp_call") op.type = "mcp.call";
    if (op.type === "mcp_list_tools") op.type = "mcp.list_tools";
    for (const key of ["mutating", "required", "classification"]) {
      if (Object.prototype.hasOwnProperty.call(op, key)) {
        throw new Error("LBP 1.2 derives classification and authority locally");
      }
    }
    if (!["mcp.call", "mcp.list_tools", "mcp.observe"].includes(op.type)) {
      throw new Error("LBP 1.2 supports mcp.call, mcp.list_tools and mcp.observe");
    }
    if (typeof op.server !== "string" || !op.server) throw new Error(`${op.type}.server is required`);
    if (op.type === "mcp.list_tools") return { type: op.type, server: op.server, ...(typeof op.description === "string" ? { description: op.description } : {}) };
    if (op.type === "mcp.observe") {
      if (!Array.isArray(op.calls) || op.calls.length < 1 || op.calls.length > MAX_OBSERVE_CALLS) {
        throw new Error(`mcp.observe requires 1..${MAX_OBSERVE_CALLS} calls`);
      }
      const calls = op.calls.map((call) => normalizeCall(call, true));
      const ids = new Set(calls.map((call) => call.id));
      if (ids.size !== calls.length) throw new Error("mcp.observe call ids must be unique");
      return {
        type: op.type,
        server: op.server,
        calls,
        ...(typeof op.description === "string" ? { description: op.description } : {})
      };
    }
    return { type: op.type, server: op.server, ...normalizeCall(op, false), ...(typeof op.description === "string" ? { description: op.description } : {}) };
  }

  function normalizeTask(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("task must be a JSON object");
    }
    if (raw.protocol && raw.protocol !== "lbp") throw new Error("task.protocol must be 'lbp'");

    let operation = raw.operation;
    if (!operation && Array.isArray(raw.operations)) {
      if (raw.operations.length !== 1) throw new Error("Legacy operations[] must contain exactly one operation");
      operation = raw.operations[0] && typeof raw.operations[0] === "object" && !Array.isArray(raw.operations[0])
        ? { ...raw.operations[0] }
        : raw.operations[0];
      if (operation && typeof operation === "object") {
        delete operation.mutating;
        delete operation.required;
      }
    }
    if (!operation) throw new Error("task.operation is required");

    const task = {
      protocol: "lbp",
      version: "1.2",
      id: raw.id,
      operation: normalizeOperation(operation)
    };
    for (const key of ["title", "description", "action_label"]) {
      if (typeof raw[key] === "string") task[key] = raw[key];
    }
    if (typeof task.id !== "string" || !task.id.trim()) throw new Error("task.id is required");
    return task;
  }

  function extractBetween(text, envelope, parse) {
    const found = [];
    let cursor = 0;
    while (true) {
      const start = text.indexOf(envelope.start, cursor);
      if (start < 0) break;
      const end = text.indexOf(envelope.end, start + envelope.start.length);
      if (end < 0) break;
      const jsonText = text.slice(start + envelope.start.length, end).trim();
      try {
        found.push({ position: start, value: parse(JSON.parse(jsonText)) });
      } catch (error) {
        found.push({
          position: start,
          value: { __parse_error: String(error.message || error), __raw: jsonText }
        });
      }
      cursor = end + envelope.end.length;
    }
    return found;
  }

  function extractTasks(text) {
    const found = [];
    for (const envelope of ENVELOPES) {
      found.push(...extractBetween(text, envelope, normalizeTask).map((item) => ({
        position: item.position,
        task: item.value
      })));
    }
    found.sort((a, b) => a.position - b.position);
    return found.map((item) => item.task);
  }

  function extractResults(text) {
    return extractBetween(text, RESULT_ENVELOPE, (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("LBP result must be a JSON object");
      }
      return value;
    }).map((item) => item.value);
  }

  function resultEnvelope(result) {
    return `\`\`\`text\n<LBP_RESULT>\n${JSON.stringify(result, null, 2)}\n</LBP_RESULT>\n\`\`\``;
  }

  return Object.freeze({
    ENVELOPES,
    RESULT_ENVELOPE,
    MAX_OBSERVE_CALLS,
    extractTasks,
    extractResults,
    resultEnvelope,
    normalizeTask
  });
})();
