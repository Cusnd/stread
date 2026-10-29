import React, { StrictMode, Suspense, startTransition, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useCommittedActions } from "../../src/useCommittedActions.js";

let pendingResolved = false, releasePending;
const pending = new Promise(resolve => { releasePending = () => { pendingResolved = true; resolve(); }; });
window.committedActionCalls = [];

function Actions({ label, handler, blocked }) {
  const [count, setCount] = useState(0);
  const actions = useCommittedActions({
    read: suffix => ({ label, count, handler, suffix }),
    invoke: () => window.committedActionCalls.push({ label, count, handler }),
    increment: () => setCount(value => value + 1),
  });
  useLayoutEffect(() => {
    window.committedActions = actions;
    window.initialCommittedActions ||= actions;
  });
  const buttons = useMemo(() => <><button onClick={actions.invoke}>Invoke retained handler</button><button onClick={actions.increment}>Increment</button></>, [actions]);
  if (blocked && !pendingResolved) { window.pendingActionRenderSeen = true; throw pending; }
  return <main>{buttons}<output>{label}:{handler}:{count}</output></main>;
}

function Fixture() {
  const [label, setLabel] = useState("initial");
  const [handler, setHandler] = useState(1);
  const [blocked, setBlocked] = useState(false);
  useLayoutEffect(() => {
    window.actionFixture = {
      replace: () => { setLabel("replacement"); setHandler(2); },
      suspend: () => startTransition(() => { setLabel("pending"); setHandler(3); setBlocked(true); }),
      release: releasePending,
    };
  }, []);
  return <Suspense fallback={<p>Pending render</p>}><Actions label={label} handler={handler} blocked={blocked} /></Suspense>;
}

createRoot(document.getElementById("root")).render(<StrictMode><Fixture /></StrictMode>);
