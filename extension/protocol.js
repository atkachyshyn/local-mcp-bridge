globalThis.LBP = (() => {
  // v0.9.2 protocol freeze. The <LBP_TASK_V1> / <ATLAS_TASK_V1> envelopes carried
  // LBP 1.1 payloads, which are no longer a runtime target, so scanning for them
  // could only ever produce a rejection. They are removed rather than left as
  // dead surface evaluated against every assistant message.
  const ENVELOPES = [
    { start: "<LBP_TASK>", end: "</LBP_TASK>", legacy: false }
  ];
  const RESULT_ENVELOPE = { start: "<LBP_RESULT>", end: "</LBP_RESULT>" };
  const MAX_OBSERVE_CALLS = 8;
  const MAX_MUTATE_CALLS = 8;
  const SUPPORTED_TASK_VERSIONS = new Set(["1.2", "1.3"]);

  function normalizeCall(raw, requireId = false, operationType = "MCP") {
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
      if (typeof raw.id !== "string" || !raw.id.trim()) throw new Error(`${operationType} calls require an id`);
      value.id = raw.id.trim();
    }
    if (typeof raw.description === "string") value.description = raw.description;
    return value;
  }

  function normalizeOperation(raw, version) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("task operation must be a JSON object");
    }
    const op = { ...raw };
    if (op.type === "mcp_call") op.type = "mcp.call";
    if (op.type === "mcp_list_tools") op.type = "mcp.list_tools";
    for (const key of ["mutating", "required", "classification"]) {
      if (Object.prototype.hasOwnProperty.call(op, key)) {
        throw new Error("LBP derives classification and authority locally");
      }
    }
    if (!["mcp.call", "mcp.list_tools", "mcp.observe", "mcp.mutate"].includes(op.type)) {
      throw new Error("LBP supports mcp.call, mcp.list_tools, mcp.observe and mcp.mutate");
    }
    if (op.type === "mcp.mutate" && version !== "1.3") {
      throw new Error("mcp.mutate requires LBP 1.3");
    }
    if (typeof op.server !== "string" || !op.server) throw new Error(`${op.type}.server is required`);
    if (op.type === "mcp.list_tools") {
      return { type: op.type, server: op.server, ...(typeof op.description === "string" ? { description: op.description } : {}) };
    }
    if (op.type === "mcp.observe" || op.type === "mcp.mutate") {
      const maxCalls = op.type === "mcp.observe" ? MAX_OBSERVE_CALLS : MAX_MUTATE_CALLS;
      if (!Array.isArray(op.calls) || op.calls.length < 1 || op.calls.length > maxCalls) {
        throw new Error(`${op.type} requires 1..${maxCalls} calls`);
      }
      const calls = op.calls.map((call) => normalizeCall(call, true, op.type));
      const ids = new Set(calls.map((call) => call.id));
      if (ids.size !== calls.length) throw new Error(`${op.type} call ids must be unique`);
      return {
        type: op.type,
        server: op.server,
        calls,
        ...(typeof op.description === "string" ? { description: op.description } : {})
      };
    }
    return { type: op.type, server: op.server, ...normalizeCall(op, false), ...(typeof op.description === "string" ? { description: op.description } : {}) };
  }

  function metadataId(value, field, max = 128) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
    const out = value.trim();
    if (out.length > max) throw new Error(`${field} must be <= ${max} characters`);
    return out;
  }

  function boundedText(value, field, max, required = false) {
    if (value == null) {
      if (required) throw new Error(`${field} must be a non-empty string`);
      return null;
    }
    if (typeof value !== "string") throw new Error(`${field} must be a string`);
    if (value.length > max) throw new Error(`${field} must be <= ${max} characters`);
    if (required && !value.trim()) throw new Error(`${field} must be a non-empty string`);
    return value;
  }

  function normalizePlanContext(raw) {
    if (raw == null) return { resources: [], constraints: [] };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("plan.context must be a JSON object");
    const resourcesRaw = raw.resources == null ? [] : raw.resources;
    const constraintsRaw = raw.constraints == null ? [] : raw.constraints;
    if (!Array.isArray(resourcesRaw) || resourcesRaw.length > 64) {
      throw new Error("plan.context.resources must be an array with at most 64 items");
    }
    if (!Array.isArray(constraintsRaw) || constraintsRaw.length > 64) {
      throw new Error("plan.context.constraints must be an array with at most 64 items");
    }
    const resources = resourcesRaw.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`plan.context.resources[${index}] must be an object`);
      }
      const resource = {
        kind: metadataId(item.kind || "resource", `plan.context.resources[${index}].kind`, 48),
        label: metadataId(item.label, `plan.context.resources[${index}].label`, 200)
      };
      if (typeof item.ref === "string" && item.ref.trim()) resource.ref = item.ref.trim().slice(0, 1000);
      return resource;
    });
    const constraints = constraintsRaw.map((item) => {
      if (typeof item !== "string" || !item.trim()) throw new Error("plan.context.constraints must contain only non-empty strings");
      return item.trim().slice(0, 300);
    });
    return { resources, constraints };
  }

  function normalizePlan(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("task.plan must be a JSON object");
    const revision = Number(raw.revision);
    if (!Number.isInteger(revision) || revision < 1) throw new Error("plan.revision must be an integer >= 1");
    if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 100) {
      throw new Error("plan.items must contain 1..100 items");
    }
    const seen = new Set();
    const items = raw.items.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`plan.items[${index}] must be an object`);
      const id = metadataId(item.id, `plan.items[${index}].id`);
      if (seen.has(id)) throw new Error(`plan item id ${id} is not unique`);
      seen.add(id);
      return {
        id,
        phase: boundedText(item.phase, `plan.items[${index}].phase`, 80) || "execute",
        title: boundedText(item.title, `plan.items[${index}].title`, 200, true),
        status: "pending"
      };
    });
    return {
      id: metadataId(raw.id, "plan.id"),
      revision,
      title: boundedText(raw.title, "plan.title", 200) || metadataId(raw.id, "plan.id"),
      items,
      context: normalizePlanContext(raw.context)
    };
  }

  function normalizeOutputs(raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw) || raw.length > 64) throw new Error("task.outputs must be an array with at most 64 items");
    const seen = new Set();
    return raw.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`task.outputs[${index}] must be an object`);
      const id = metadataId(item.id, `task.outputs[${index}].id`);
      if (seen.has(id)) throw new Error(`task.outputs id ${id} is not unique`);
      seen.add(id);
      const output = {
        id,
        label: metadataId(item.label, `task.outputs[${index}].label`, 200),
        kind: metadataId(item.kind, `task.outputs[${index}].kind`, 80)
      };
      if (typeof item.ref === "string" && item.ref.trim()) output.ref = item.ref.trim().slice(0, 1000);
      return output;
    });
  }

  function normalizeTask(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("task must be a JSON object");
    }
    if (raw.protocol && raw.protocol !== "lbp") throw new Error("task.protocol must be 'lbp'");
    const version = raw.version === undefined || raw.version === null ? "1.2" : String(raw.version);
    if (!SUPPORTED_TASK_VERSIONS.has(version)) {
      throw new Error(`task.version must be '1.2' or '1.3'; LBP 1.1 is historical and is not a runtime target (got ${version})`);
    }

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
      version,
      id: raw.id,
      operation: normalizeOperation(operation, version)
    };
    for (const key of ["title", "description", "action_label"]) {
      if (typeof raw[key] === "string") task[key] = raw[key];
    }
    if (typeof task.id !== "string" || !task.id.trim()) throw new Error("task.id is required");
    if (raw.plan !== undefined) {
      if (version !== "1.3") throw new Error("task.plan requires LBP 1.3");
      task.plan = normalizePlan(raw.plan);
    }
    if (raw.plan_id !== undefined) task.plan_id = metadataId(raw.plan_id, "task.plan_id");
    if (raw.plan_item_id !== undefined) task.plan_item_id = metadataId(raw.plan_item_id, "task.plan_item_id");
    if (raw.plan_revision !== undefined) {
      const revision = Number(raw.plan_revision);
      if (!Number.isInteger(revision) || revision < 1) throw new Error("task.plan_revision must be an integer >= 1");
      task.plan_revision = revision;
    }
    if (raw.outputs !== undefined) {
      if (version !== "1.3") throw new Error("task.outputs requires LBP 1.3");
      task.outputs = normalizeOutputs(raw.outputs);
    }
    return task;
  }

  function extractBetween(text, envelope, parse) {
    const found = [];
    const lines = String(text || "").split("\n");
    const offsets = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length + 1;
    }
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() !== envelope.start) continue;
      let endIndex = index + 1;
      while (endIndex < lines.length && lines[endIndex].trim() !== envelope.end) endIndex += 1;
      if (endIndex >= lines.length) continue;
      const jsonText = lines.slice(index + 1, endIndex).join("\n").trim();
      const start = offsets[index] + Math.max(0, lines[index].indexOf(envelope.start));
      try {
        found.push({ position: start, value: parse(JSON.parse(jsonText)) });
      } catch (error) {
        found.push({
          position: start,
          value: { __parse_error: String(error.message || error), __raw: jsonText }
        });
      }
      index = endIndex;
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

  // --- Canonical JSON + semantic equality -------------------------------------
  // Composer text round-trips through a contenteditable that reflows whitespace
  // and may reorder nothing but re-indent everything. Byte comparison therefore
  // produces false negatives. Strictness lives in parsePureResultEnvelope below,
  // which refuses anything that is not exactly one envelope and nothing else;
  // only after that gate passes do we compare the parsed objects semantically.
  function canonicalJson(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }

  function semanticallyEqual(a, b) {
    return canonicalJson(a) === canonicalJson(b);
  }

  const RESULT_STATUSES = new Set(["ok", "error", "unknown"]);

  function validateResultShape(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("LBP result must be a JSON object");
    }
    if (value.protocol !== "lbp") throw new Error("LBP result protocol must be 'lbp'");
    if (typeof value.task_id !== "string" || !value.task_id.trim()) {
      throw new Error("LBP result task_id is required");
    }
    if (!RESULT_STATUSES.has(value.status)) {
      throw new Error(`LBP result status must be one of ${[...RESULT_STATUSES].join(", ")}`);
    }
    if (!value.operation || typeof value.operation !== "object" || Array.isArray(value.operation)) {
      throw new Error("LBP result operation must be a JSON object");
    }
    return value;
  }

  // Strict whole-message pure-result parse.
  //
  // This is the gate that decides whether a user turn is a bridge result or a
  // genuine human prompt, so it must not accept an envelope with anything around
  // it. A message that merely CONTAINS a result envelope is a human turn: treating
  // it as a bridge turn would let a human countermand pass without rotating the
  // chain or resetting approval scope.
  //
  // Returns the parsed result object, or null when the text is not a pure result.
  function parsePureResultEnvelope(text) {
    let body = String(text == null ? "" : text).trim();
    if (!body) return null;

    // One optional fenced wrapper, which is how the composer renders our own
    // insertion. Anything else around the fence disqualifies the message.
    const fence = body.match(/^```(?:[A-Za-z0-9_-]*)\n([\s\S]*?)\n?```$/);
    if (fence) body = fence[1].trim();
    if (body.includes("```")) return null;

    if (markerCount(body, RESULT_ENVELOPE.start) !== 1) return null;
    if (markerCount(body, RESULT_ENVELOPE.end) !== 1) return null;

    const lines = body.split("\n");
    if (lines[0].trim() !== RESULT_ENVELOPE.start) return null;
    if (lines[lines.length - 1].trim() !== RESULT_ENVELOPE.end) return null;

    const jsonText = lines.slice(1, -1).join("\n").trim();
    if (!jsonText) return null;
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_) {
      return null;
    }
    try {
      return validateResultShape(parsed);
    } catch (_) {
      return null;
    }
  }

  function markerCount(text, marker) {
    return String(text || "").split(marker).length - 1;
  }

  function resultEnvelope(result) {
    return `\`\`\`text\n<LBP_RESULT>\n${JSON.stringify(result, null, 2)}\n</LBP_RESULT>\n\`\`\``;
  }

  return Object.freeze({
    ENVELOPES,
    RESULT_ENVELOPE,
    MAX_OBSERVE_CALLS,
    MAX_MUTATE_CALLS,
    extractTasks,
    extractResults,
    resultEnvelope,
    normalizeTask,
    parsePureResultEnvelope,
    validateResultShape,
    canonicalJson,
    semanticallyEqual,
    SUPPORTED_TASK_VERSIONS
  });
})();
