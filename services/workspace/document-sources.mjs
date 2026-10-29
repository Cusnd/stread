// Reading-time source lookup is a projection of the saved document revision.
// Page-only sources intentionally have no invented rectangle.
export function documentSourceRegions(document) {
  const validBox = (box) => Array.isArray(box) && box.length === 4 && box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && box[0] < box[2] && box[1] < box[3];
  return (document.blocks || []).filter((block) => block.origin !== "user").flatMap((block) =>
    [block, ...(block.items || []).filter((item) => item.origin !== "user")].flatMap((item) =>
      (item.source || []).filter((source) => Number.isInteger(source.page) && source.page > 0).map((source) => ({
        blockId: block.id, ...(item === block ? {} : { itemId: item.id }), page: source.page,
        ...(validBox(source.box) ? { box: [...source.box] } : {}),
      })))).sort((a, b) => a.page - b.page || (a.box?.[1] ?? 1) - (b.box?.[1] ?? 1))
    .map((region, regionIndex) => ({ ...region, regionIndex }));
}
