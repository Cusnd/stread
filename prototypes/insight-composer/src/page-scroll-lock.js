const locks = new WeakMap();

export function acquirePageScrollLock(root = document.documentElement) {
  let entry = locks.get(root);
  if (!entry) {
    entry = { count: 0, overflow: root.style.overflow, gutter: root.style.scrollbarGutter };
    locks.set(root, entry);
    root.style.scrollbarGutter = "stable";
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
    locks.delete(root);
  };
}
