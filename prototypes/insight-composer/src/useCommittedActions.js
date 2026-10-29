import { useLayoutEffect, useMemo, useRef } from "react";

// Action names are fixed for a mounted owner. Call these from events, not
// render: identities stay stable while handlers follow committed state.
export function useCommittedActions(actions) {
  const committed = useRef(actions);
  useLayoutEffect(() => { committed.current = actions; });
  return useMemo(() => Object.fromEntries(Object.keys(actions).map((name) =>
    [name, (...args) => committed.current[name](...args)])), []);
}
