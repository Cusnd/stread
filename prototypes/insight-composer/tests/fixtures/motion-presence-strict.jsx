import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { motion } from "motion/react";
import { useMotionPresence } from "../../src/useMotionPresence.js";

// Keep the hook owner mounted while the motion child is conditionally mounted.
// In development StrictMode only that new child replays its effects and refs.
function Fixture() {
  const [open, setOpen] = useState(false);
  const [exits, setExits] = useState(0);
  const [snapshot, setSnapshot] = useState("No snapshot");
  const panelRef = useRef(null);
  const presence = useMotionPresence(open, { onExit: () => setExits((value) => value + 1) });
  const observe = () => {
    const node = panelRef.current;
    const bounds = node?.getBoundingClientRect();
    setSnapshot(JSON.stringify({ open, present: presence.present, exits,
      opacity: node ? Number(getComputedStyle(node).opacity) : null,
      width: bounds?.width ?? null, height: bounds?.height ?? null,
      draft: document.querySelector("textarea")?.value ?? null,
    }));
  };
  return <main style={{ font: "16px system-ui", padding: 30 }}>
    <h1>StrictMode conditional motion surface</h1>
    <p>The hook stays mounted; opening mounts its motion child.</p>
    <div style={{ display: "flex", gap: 12 }}>
      <button onClick={() => setOpen(true)}>Open</button>
      <button onClick={() => setOpen(false)}>Close</button>
      <button onClick={() => { setOpen(false); requestAnimationFrame(() => setOpen(true)); }}>Reverse close</button>
      <button onClick={observe}>Snapshot</button>
    </div>
    <p><output data-testid="lifecycle">{JSON.stringify({ open, present: presence.present, exits })}</output></p>
    <output data-testid="snapshot">{snapshot}</output>
    {presence.present && <div style={{ marginTop: 20, padding: 24, background: "#ddd", minHeight: 260 }}>
      <motion.section {...presence.motionProps} ref={panelRef} role="dialog" aria-label="Motion fixture" inert={!open}
        style={{ width: 440, padding: 24, background: "white", boxShadow: "0 8px 24px #0002" }}>
        <h2>Visible settings surface</h2>
        <textarea aria-label="Persistent draft" defaultValue="draft survives a reversed exit" />
        <button onClick={() => setOpen(false)}>Close panel</button>
      </motion.section>
    </div>}
  </main>;
}

createRoot(document.getElementById("root")).render(<React.StrictMode><Fixture /></React.StrictMode>);
