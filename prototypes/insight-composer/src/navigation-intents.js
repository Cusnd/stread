// Navigation owns its foreground feedback until settled or superseded. Every
// direct navigation invalidates pending asynchronous opens, including returning
// to the same page; comparing only route strings cannot distinguish that intent.
export function createNavigationIntents() {
  let generation = 0, active = null;
  function invalidate() {
    generation += 1;
    const previous = active;
    active = null;
    previous?.finish();
  }
  function begin(onFinish = () => {}) {
    invalidate();
    const ownGeneration = generation;
    let finished = false;
    const intent = {
      current: () => !finished && ownGeneration === generation && active === intent,
      finish() {
        if (finished) return;
        finished = true;
        if (active === intent) active = null;
        onFinish();
      },
    };
    active = intent;
    return intent;
  }
  return { begin, invalidate };
}
