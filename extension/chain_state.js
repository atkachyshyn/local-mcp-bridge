(() => {
  const MAX_TRACKED_TASK_IDS = 256;

  function cleanTaskIds(values) {
    const out = [];
    for (const value of Array.isArray(values) ? values : []) {
      if (typeof value !== "string" || !value) continue;
      if (!out.includes(value)) out.push(value);
    }
    return out.slice(-MAX_TRACKED_TASK_IDS);
  }

  function normalize(input = {}) {
    const taskIds = cleanTaskIds(input.taskIds || input.submittedTaskIds);
    const checkpointPasses = Number.isInteger(input.checkpointPasses) && input.checkpointPasses >= 0
      ? input.checkpointPasses
      : 0;
    return {
      anchor: typeof input.anchor === "string" && input.anchor ? input.anchor : null,
      id: typeof input.id === "string" && input.id ? input.id : null,
      roundTrips: taskIds.length,
      stopped: input.stopped === true,
      taskIds,
      checkpointPasses
    };
  }

  function start(anchor, id) {
    return normalize({ anchor, id, stopped: false, taskIds: [], checkpointPasses: 0 });
  }

  function recover({ anchor = null, id = null, taskIds = [], stopped = false, checkpointPasses = 0 } = {}) {
    return normalize({ anchor, id, stopped, taskIds, checkpointPasses });
  }

  function syncHumanAnchor(input, { anchor, id } = {}) {
    const state = normalize(input);
    if (typeof anchor !== "string" || !anchor || anchor === state.anchor) return state;
    return start(anchor, id);
  }

  function grantCheckpoint(input) {
    const state = normalize(input);
    return normalize({ ...state, stopped: false, checkpointPasses: state.checkpointPasses + 1 });
  }

  function stop(input) {
    return normalize({ ...normalize(input), stopped: true });
  }

  function resume(input) {
    return normalize({ ...normalize(input), stopped: false });
  }

  globalThis.LBP_CHAIN_STATE = Object.freeze({
    normalize,
    start,
    recover,
    syncHumanAnchor,
    grantCheckpoint,
    stop,
    resume
  });
})();
