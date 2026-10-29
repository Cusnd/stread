// Keep precise line coordinates for source navigation, but present one calm
// selection surface for each paragraph on a page. A page break stays separate.
export function paragraphRegions(regions) {
  const groups = new Map();
  for (const region of regions) {
    if (!region.box) continue;
    const key = JSON.stringify([region.page, region.blockId, region.itemId]);
    const current = groups.get(key);
    if (!current) groups.set(key, { ...region, box: [...region.box] });
    else current.box = [Math.min(current.box[0], region.box[0]), Math.min(current.box[1], region.box[1]),
      Math.max(current.box[2], region.box[2]), Math.max(current.box[3], region.box[3])];
  }
  const areas = [...groups.values()];
  // Item geometry takes precedence over a list-wide backdrop on the same page.
  return areas.filter((region) => region.itemId || !areas.some((item) => item.itemId && item.page === region.page && item.blockId === region.blockId));
}
