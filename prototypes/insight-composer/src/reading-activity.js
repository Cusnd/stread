const OUTBOX_PREFIX = "continuous-reader:reading-activity:v1:";
const COMMAND_KINDS = new Set(["reading.session.start", "reading.session.activity", "reading.session.end"]);
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

/**
 * Foreground reading timer, independent of React and the reader DOM.
 *
 * start({ documentId, documentRevision, position?, mode? }) begins a session;
 * updatePosition(position) supplies the eventual end position. A second start
 * closes the previous article. end(reason) closes without destroying the tracker;
 * dispose() closes, removes listeners/timers, and starts one final outbox drain.
 * All methods are synchronous except flush(), which resolves after the current
 * drain. Transport failures remain in the outbox and are retried on heartbeat,
 * online, or an explicit flush. onError/onStatus let the host expose failures.
 * If start() returns null because the outbox is full, the requested Reader is
 * deferred until capacity recovers. end()/dispose() cancel that deferred start;
 * updatePosition() still updates its eventual starting position while waiting.
 *
 * Each localStorage item contains one immutable command. Concurrent tabs may
 * retry the same item safely; they cannot overwrite one another's new entries.
 * The server remains responsible for idempotency and overlapping-session totals.
 */
export function createReadingActivityTracker(options) {
  if (typeof options?.sendCommand !== "function") throw new TypeError("sendCommand is required");
  const {
    sendCommand, windowTarget = globalThis.window, documentTarget = globalThis.document,
    wallNow = Date.now, monotonicNow = () => globalThis.performance.now(),
    createId = () => globalThis.crypto.randomUUID(),
    setInterval: schedule = globalThis.setInterval, clearInterval: unschedule = globalThis.clearInterval,
    heartbeatMs = 15_000, idleMs = 300_000, maxGapMs = 45_000, retryMs = 30_000,
    maxPending = 4096, storagePrefix = OUTBOX_PREFIX, onError = () => {}, onStatus = () => {},
  } = options;
  if (!(heartbeatMs > 0 && heartbeatMs <= maxGapMs && maxGapMs <= 60_000 && idleMs > 0 && maxPending >= 3)) {
    throw new RangeError("Invalid reading activity timer limits");
  }
  let storage = options.storage;
  let storageUnavailable = null;
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch (error) { storageUnavailable = error; }
  }
  const memory = new Map();
  let session = null, pendingStart = null, timer = null, retryTimer = null, disposed = false, draining = null, lastError = null, pageRestore = null;
  let visible = documentTarget?.visibilityState !== "hidden";
  let focused = documentTarget?.hasFocus ? documentTarget.hasFocus() : true;
  let bufferPaused = false, suspended = false;
  const bindings = [];
  const snapshot = () => ({ wall: wallNow(), mono: monotonicNow() });
  let baseline = snapshot(), lastActivity = baseline.mono;

  function report(error, code = error?.code || "READING_ACTIVITY_SYNC") {
    lastError = { code, message: error?.message || String(error), error };
    try { onError(lastError); } catch { /* A UI callback cannot interrupt recording. */ }
    statusChanged();
  }

  function readRecords() {
    const values = new Map(memory);
    if (storage) {
      try {
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index);
          if (!key?.startsWith(storagePrefix)) continue;
          try {
            const record = JSON.parse(storage.getItem(key));
            if (record?.v !== 1 || !COMMAND_KINDS.has(record.command?.kind) ||
              record.command.requestId !== key.slice(storagePrefix.length) ||
              typeof record.command.sessionId !== "string" || !Number.isInteger(record.ordinal)) {
              throw new Error("阅读时间的本地待保存记录无法识别，原始记录已保留。");
            }
            values.set(key, record);
          } catch (error) {
            // Preserve malformed records for recovery instead of erasing the outbox.
            if (lastError?.code !== "READING_ACTIVITY_STORAGE_RECORD") report(error, "READING_ACTIVITY_STORAGE_RECORD");
          }
        }
      } catch (error) {
        if (lastError?.code !== "READING_ACTIVITY_STORAGE") report(error, "READING_ACTIVITY_STORAGE");
      }
    }
    return [...values].sort(([, left], [, right]) => {
      if (left.command.sessionId === right.command.sessionId) return left.ordinal - right.ordinal;
      return left.sessionStartedAt.localeCompare(right.sessionStartedAt) || left.command.sessionId.localeCompare(right.command.sessionId);
    });
  }

  function getStatus() {
    return {
      sessionId: session?.id || null, documentId: session?.documentId || pendingStart?.documentId || null,
      recording: !!session && visible && focused && !bufferPaused && !suspended && monotonicNow() - lastActivity < idleMs,
      pausedReason: pendingStart ? "buffer-full" : !session ? "stopped" : !visible || !focused ? "background" : bufferPaused ? "buffer-full" : suspended ? "suspended" : monotonicNow() - lastActivity >= idleMs ? "idle" : null,
      pending: readRecords().length, error: lastError,
    };
  }

  function statusChanged() {
    // Avoid readRecords -> report -> statusChanged recursion for broken storage.
    try { onStatus({ sessionId: session?.id || null, error: lastError, bufferPaused, pendingStart: Boolean(pendingStart) }); } catch { }
  }

  function maintainRetryTimer() {
    if (disposed || readRecords().length === 0) {
      if (retryTimer !== null) { unschedule(retryTimer); retryTimer = null; }
    } else if (retryTimer === null) {
      // Retry delivery even after navigation has stopped the reading heartbeat.
      // This timer never samples or adds reading time.
      retryTimer = schedule(() => { void flush(); }, retryMs);
    }
  }

  function enqueue(command, ordinal, limit = maxPending) {
    if (readRecords().length >= limit) {
      bufferPaused = true;
      if (lastError?.code !== "READING_ACTIVITY_BUFFER_FULL") {
        report(new Error("阅读时间待保存记录已满，已暂停新增计时；已有记录会在本地服务恢复后继续保存。"), "READING_ACTIVITY_BUFFER_FULL");
      }
      return false;
    }
    const record = { v: 1, ordinal, sessionStartedAt: session.startedAt, command: clone(command) };
    const key = storagePrefix + command.requestId;
    // The in-memory copy also protects in-flight records when localStorage is
    // temporarily unavailable or its quota is exhausted.
    memory.set(key, record);
    if (storage) {
      try { storage.setItem(key, JSON.stringify(record)); }
      catch (error) { report(error, "READING_ACTIVITY_STORAGE"); }
    } else if (!lastError) {
      report(storageUnavailable || new Error("浏览器存储不可用，尚未写入资料库的阅读时间只能保留到本次页面关闭。"), "READING_ACTIVITY_STORAGE");
    }
    statusChanged();
    maintainRetryTimer();
    return true;
  }

  async function flush() {
    if (draining) return draining;
    draining = Promise.resolve().then(async () => {
      const rejectedSessions = new Set();
      while (true) {
        if (pendingStart && !disposed && readRecords().length < maxPending - 2) {
          const input = pendingStart, previousActivity = lastActivity;
          // Capacity recovery opens only the still-requested Reader, starting
          // now. It must not backfill the pause or revive an already idle user.
          pendingStart = null;
          start(input);
          lastActivity = previousActivity;
        }
        const entry = readRecords().find(([, record]) => !rejectedSessions.has(record.command.sessionId));
        if (!entry) break;
        const [key, record] = entry;
        try {
          // Give transports a copy, preserving the durable immutable retry input.
          await sendCommand(clone(record.command));
          if (storage) storage.removeItem(key);
          memory.delete(key);
          if (bufferPaused && readRecords().length < maxPending - 1) {
            bufferPaused = false;
            baseline = snapshot(); // Never backfill the period paused for a full buffer.
          }
        } catch (error) {
          report(error);
          // A rejected old session must not block every later valid session.
          // Preserve all its commands, and keep its own start/activity/end order.
          // Network/rate-limit errors pause the whole drain until the next retry.
          if (error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
            rejectedSessions.add(record.command.sessionId);
          } else break;
        }
      }
      if (readRecords().length === 0) lastError = null;
      maintainRetryTimer();
      statusChanged();
      return { pending: readRecords().length, error: lastError };
    });
    try { return await draining; } finally { draining = null; }
  }

  function sample() {
    const current = snapshot(), previous = baseline;
    baseline = current;
    if (!session || !visible || !focused || bufferPaused || suspended) return;
    const elapsed = current.mono - previous.mono, wallElapsed = current.wall - previous.wall;
    // Sleep, delayed timers, clock rollback and wall/monotonic disagreement are
    // unobserved time. Resume only after fresh input/focus; do not guess it.
    if (elapsed < 0 || elapsed > maxGapMs || wallElapsed < 0 || previous.wall < session.lastRecordedEnd || Math.abs(wallElapsed - elapsed) > 2_000) {
      suspended = true;
      statusChanged();
      return;
    }
    const activeMs = Math.floor(Math.max(0, Math.min(elapsed, lastActivity + idleMs - previous.mono)));
    if (!activeMs) return;
    const sequence = session.sequence + 1;
    const command = {
      kind: "reading.session.activity", requestId: createId(), sessionId: session.id, sequence,
      startedAt: new Date(previous.wall).toISOString(), endedAt: new Date(previous.wall + activeMs).toISOString(), activeMs,
    };
    // Reserve one item for the session end even during a prolonged outage.
    if (enqueue(command, sequence, maxPending - 1)) {
      session.sequence = sequence;
      session.lastRecordedEnd = previous.wall + activeMs;
    }
  }

  function freshActivity() {
    if ((!session && !pendingStart) || !visible || !focused) return;
    const current = snapshot();
    // Ordinary wheel/input events refresh attention without turning every event
    // into a network interval. Settle only an idle or interrupted boundary.
    if (suspended || current.mono - lastActivity >= idleMs || current.mono - baseline.mono > maxGapMs ||
      Math.abs((current.wall - baseline.wall) - (current.mono - baseline.mono)) > 2_000) {
      sample();
      baseline = snapshot();
    }
    lastActivity = current.mono;
    suspended = false;
  }

  function changeForeground(nextVisible, nextFocused) {
    sample();
    const wasForeground = visible && focused;
    visible = nextVisible;
    focused = nextFocused;
    baseline = snapshot();
    if (visible && focused && !wasForeground) {
      lastActivity = baseline.mono;
      suspended = false;
    }
    statusChanged();
    void flush();
  }

  function bind(target, name, callback, settings) {
    if (!target?.addEventListener) return;
    target.addEventListener(name, callback, settings);
    bindings.push(() => target.removeEventListener(name, callback, settings));
  }

  function updatePosition(position) {
    if (session) session.position = clone(position);
    else if (pendingStart) pendingStart.position = clone(position);
  }

  function end(reason = "leave") {
    if (pendingStart) {
      pendingStart = null;
      bufferPaused = false;
      statusChanged();
    }
    if (!session) return null;
    sample();
    const id = session.id;
    enqueue({ kind: "reading.session.end", requestId: createId(), sessionId: id,
      endedAt: new Date(Math.max(wallNow(), session.lastRecordedEnd)).toISOString(), ...(session.position != null ? { position: session.position } : {}), reason }, session.sequence + 1);
    session = null;
    if (timer !== null) { unschedule(timer); timer = null; }
    statusChanged();
    void flush();
    return id;
  }

  function start({ documentId, documentRevision, position, mode } = {}) {
    if (disposed) throw new Error("Reading activity tracker has been disposed");
    if (typeof documentId !== "string" || !documentId || !Number.isInteger(documentRevision) || documentRevision < 1) {
      throw new TypeError("A persisted document and positive documentRevision are required");
    }
    if (session?.documentId === documentId && session.documentRevision === documentRevision) {
      if (position !== undefined) updatePosition(position);
      return session.id;
    }
    end("document-switch");
    baseline = snapshot();
    lastActivity = baseline.mono;
    visible = documentTarget?.visibilityState !== "hidden";
    focused = documentTarget?.hasFocus ? documentTarget.hasFocus() : true;
    suspended = false;
    session = { id: createId(), documentId, documentRevision, position: clone(position), mode,
      startedAt: new Date(baseline.wall).toISOString(), lastRecordedEnd: baseline.wall, sequence: 0 };
    const accepted = enqueue({ kind: "reading.session.start", requestId: createId(), sessionId: session.id,
      documentId, documentRevision, startedAt: session.startedAt,
      ...(position != null ? { position } : {}), ...(mode != null ? { mode } : {}) }, 0, maxPending - 2);
    if (!accepted) {
      session = null;
      pendingStart = { documentId, documentRevision, position: clone(position), mode };
      statusChanged(); maintainRetryTimer();
      return null;
    }
    bufferPaused = false;
    timer = schedule(() => { sample(); void flush(); }, heartbeatMs);
    statusChanged();
    void flush();
    return session.id;
  }

  bind(windowTarget, "blur", () => changeForeground(visible, false));
  bind(windowTarget, "focus", () => changeForeground(documentTarget?.visibilityState !== "hidden", true));
  bind(documentTarget, "visibilitychange", () => changeForeground(documentTarget?.visibilityState !== "hidden", documentTarget?.hasFocus ? documentTarget.hasFocus() : focused));
  bind(windowTarget, "online", () => { void flush(); });
  bind(windowTarget, "pagehide", (event) => {
    const reader = session || pendingStart;
    pageRestore = event.persisted && reader ? { documentId: reader.documentId, documentRevision: reader.documentRevision, position: clone(reader.position), mode: reader.mode } : null;
    end("pagehide");
  });
  bind(windowTarget, "pageshow", (event) => {
    if (event.persisted && pageRestore && !session && !disposed) {
      const input = pageRestore; pageRestore = null;
      start(input);
    }
  });
  for (const event of ["wheel", "keydown", "pointerdown", "input"]) bind(documentTarget, event, freshActivity, { capture: true, passive: true });

  function dispose() {
    if (disposed) return;
    end("unmount");
    disposed = true;
    maintainRetryTimer();
    for (const unbind of bindings) unbind();
    void flush();
  }

  // A returning Collection/Flow page also drains any previous offline session.
  void flush();
  return { start, updatePosition, end, flush, dispose, getStatus };
}
