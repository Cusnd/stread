const locks = new WeakMap();

export function acquirePageScrollLock(root = document.documentElement) {
  let entry = locks.get(root);
  if (!entry) {
    entry = { count: 0, overflow: root.style.overflow, gutter: root.style.scrollbarGutter };
    const view = root.ownerDocument?.defaultView;
    if (view) {
      const bounds = root.getBoundingClientRect();
      const computed = view.getComputedStyle(root);
      entry.padding = [];
      for (const [property, width] of [["paddingLeft", Math.max(0, bounds.left)], ["paddingRight", Math.max(0, view.innerWidth - bounds.right)]]) {
        if (!width) continue;
        entry.padding.push([property, root.style[property]]);
        root.style[property] = `calc(${computed[property]} + ${width}px)`;
      }
    }
    locks.set(root, entry);
    // A reserved root gutter sits outside modal backdrops. Keep its layout
    // space as padding so the dimmed surface can paint to the window edge.
    root.style.scrollbarGutter = "auto";
    root.style.overflow = "hidden";
  }
  entry.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.count) return;
    root.style.overflow = entry.overflow;
    root.style.scrollbarGutter = entry.gutter;
    for (const [property, value] of entry.padding || []) root.style[property] = value;
    locks.delete(root);
  };
}
