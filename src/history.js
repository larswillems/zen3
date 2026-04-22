// Undo/redo history for the entire authored scenario.
//
// We snapshot the scenario as a serialized JSON string (via
// Simulator.getScenario) and maintain a linear stack with an `index` pointer:
// index always points at the "current" snapshot. Undo moves the pointer back
// and re-applies; Redo moves forward; any new commit after an undo truncates
// the tail ("branch discard", same as every editor).
//
// Granularity:
//   - Discrete actions (add, delete, duplicate, preset load, etc.) call
//     commit() directly.
//   - Continuous edits (sliders, drags) call scheduleCommit(), which
//     debounces so a full slider sweep becomes ONE history entry.
//
// While applying an undo/redo we set `_suppress = true` so the UI's own
// "something changed" hooks don't push the restored state back onto the
// stack as a duplicate.

class History {
  constructor(app, { max = 100, debounceMs = 350 } = {}) {
    this.app = app;
    this.max = max;
    this.debounceMs = debounceMs;
    this.stack = [];
    this.index = -1;
    this._timer = null;
    this._suppress = false;
  }

  _snapshot() {
    return JSON.stringify(this.app.simulator.getScenario());
  }

  // Seed the stack with the current scenario as the baseline.
  init() {
    this.stack = [this._snapshot()];
    this.index = 0;
    this._updateButtons();
  }

  // Push the current scenario if it differs from the stack top.
  commit() {
    if (this._suppress) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const snap = this._snapshot();
    if (this.stack[this.index] === snap) return;
    // Drop any redo-future before pushing a new branch.
    this.stack.length = this.index + 1;
    this.stack.push(snap);
    // Cap the ring buffer; shift drops the oldest snapshot.
    if (this.stack.length > this.max) this.stack.shift();
    this.index = this.stack.length - 1;
    this._updateButtons();
  }

  // Debounced commit: rapid slider changes collapse into one entry.
  scheduleCommit() {
    if (this._suppress) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.commit();
    }, this.debounceMs);
  }

  // Force any pending debounced commit to happen NOW. Call before undo/redo
  // so the current in-flight edit is captured before we rewind past it.
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      this.commit();
    }
  }

  canUndo() { return this.index > 0; }
  canRedo() { return this.index < this.stack.length - 1; }

  undo() {
    this.flush();
    if (!this.canUndo()) return false;
    this.index--;
    this._apply(this.stack[this.index]);
    return true;
  }

  redo() {
    this.flush();
    if (!this.canRedo()) return false;
    this.index++;
    this._apply(this.stack[this.index]);
    return true;
  }

  _apply(snapStr) {
    this._suppress = true;
    try {
      const sc = JSON.parse(snapStr);
      // setScenario deep-copies and calls rebuild(). Events engine needs a
      // fresh rule list too, since it holds per-rule fired-once state.
      this.app.simulator.setScenario(sc);
      if (this.app.events) this.app.events.setRules(sc.events || []);
      if (this.app.ui) {
        const prev = this.app.ui.selectedId;
        const stillExists = sc.objects.some((o) => o.id === prev);
        this.app.ui.select(stillExists ? prev : null);
        this.app.ui.refreshAll();
      }
    } finally {
      this._suppress = false;
    }
    this._updateButtons();
  }

  _updateButtons() {
    const u = document.getElementById('btn-undo');
    const r = document.getElementById('btn-redo');
    if (u) u.disabled = !this.canUndo();
    if (r) r.disabled = !this.canRedo();
  }
}

window.History = History;
