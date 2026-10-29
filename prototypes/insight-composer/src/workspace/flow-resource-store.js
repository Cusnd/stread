// Flow resources live only in this browser context. URLs include the origin so
// a development workspace can never reuse a production workspace's response.
export function createFlowResourceStore({ maxEntries = 40, getOrigin = () => window.location.origin } = {}) {
  const cache = new Map();
  const pending = new Map();

  const describe = (url) => {
    const origin = getOrigin();
    const target = new URL(url, origin);
    if (target.origin !== origin) throw new TypeError("Flow resources must use the current origin.");
    target.hash = "";
    target.searchParams.sort();
    const key = target.href;
    const offset = Number(target.searchParams.get("offset")) || 0;
    const limit = Number(target.searchParams.get("limit")) || 0;
    target.searchParams.delete("offset");
    target.searchParams.delete("limit");
    return { key, identity: target.href, offset, limit };
  };

  const remember = (descriptor, data) => {
    cache.delete(descriptor.key);
    cache.set(descriptor.key, { ...descriptor, data });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  };

  return {
    identity(url) { return url ? describe(url).identity : null; },
    has(url) { return Boolean(url && cache.has(describe(url).key)); },
    read(url) {
      if (!url) return null;
      const descriptor = describe(url);
      const exact = cache.get(descriptor.key);
      if (exact) { remember(descriptor, exact.data); return exact.data; }
      // Expanding a list retains its already loaded rows. A different query,
      // date range, filter or offset never borrows an unrelated result.
      if (!descriptor.limit) return null;
      const previous = [...cache.values()].reverse().find((entry) => entry.identity === descriptor.identity && entry.offset === descriptor.offset && Array.isArray(entry.data?.items));
      if (!previous) return null;
      const items = previous.data.items.slice(0, descriptor.limit);
      return { ...previous.data, offset: descriptor.offset, limit: descriptor.limit, items, hasMore: previous.data.hasMore || items.length < previous.data.items.length };
    },
    acquire(url, { version, load }) {
      const descriptor = describe(url);
      let entry = pending.get(descriptor.key);
      if (!entry || entry.version !== version || entry.controller.signal.aborted) {
        const controller = new AbortController();
        entry = { version, controller, consumers: 0, promise: null };
        const request = entry;
        entry.promise = Promise.resolve().then(() => load(url, controller.signal)).then((data) => {
          // An older workspace revision may finish after its replacement. It
          // must neither replace fresh cache data nor notify a new selection.
          if (!controller.signal.aborted && pending.get(descriptor.key) === request) remember(descriptor, data);
          return data;
        }).finally(() => {
          if (pending.get(descriptor.key) === request) pending.delete(descriptor.key);
        });
        pending.set(descriptor.key, entry);
      }
      entry.consumers += 1;
      let released = false;
      return {
        promise: entry.promise,
        release() {
          if (released) return;
          released = true;
          entry.consumers -= 1;
          // React's development effect replay can reacquire the same request
          // before this microtask; shared readers keep their request alive.
          queueMicrotask(() => {
            if (entry.consumers) return;
            entry.controller.abort();
            if (pending.get(descriptor.key) === entry) pending.delete(descriptor.key);
          });
        },
      };
    },
  };
}

export const flowResourceStore = createFlowResourceStore();
