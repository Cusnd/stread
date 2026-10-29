/** A fetch deadline whose resources end with the complete response body. */
export function createRequestDeadline(timeoutMs, callerSignal) {
  const controller = new AbortController();
  let timer, listening = false, timedOut = false;
  function dispose() {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (listening) { callerSignal.removeEventListener("abort", onCallerAbort); listening = false; }
  }
  function onCallerAbort() {
    controller.abort(callerSignal.reason);
    dispose();
  }
  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  else {
    if (callerSignal) { callerSignal.addEventListener("abort", onCallerAbort, { once: true }); listening = true; }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("The request deadline was exceeded.", "TimeoutError"));
      dispose();
    }, timeoutMs);
    // Node's AbortSignal.timeout does not keep an otherwise idle process alive.
    // Workerd returns a numeric timer ID and still clears it in dispose().
    timer.unref?.();
  }
  return { signal: controller.signal, get timedOut() { return timedOut; }, dispose };
}
