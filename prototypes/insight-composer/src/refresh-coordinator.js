// A background owner can cancel its entire refresh. A deliberate command can
// promote that same in-flight work, so hiding a page cannot cancel save feedback.
export function createRefreshCoordinator() {
  let current;
  return {
    run(load, { signal, minimumRevision } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
      if (current && !current.controller.signal.aborted) {
        if (!signal) current.detach();
        if (minimumRevision === undefined) return current.promise;
        // A GET begun before a save is not evidence that the save is visible.
        // Reuse it only if its returned revision covers that committed receipt.
        return current.promise.then((value) => value.revision >= minimumRevision ? value : this.run(load, { signal, minimumRevision }),
          (error) => { if (signal?.aborted) throw error; return this.run(load, { signal, minimumRevision }); });
      }
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const entry = { controller, detach: () => signal?.removeEventListener("abort", abort), promise: null };
      current = entry;
      entry.promise = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return load(controller.signal); }).finally(() => {
        entry.detach(); if (current === entry) current = null;
      });
      return entry.promise;
    },
    cancel() { current?.controller.abort(); },
  };
}
