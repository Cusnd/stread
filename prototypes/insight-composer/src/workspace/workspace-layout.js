export const WORKSPACE_NAVIGATION_WIDTH = 184;
export const WORKSPACE_COMPACT_NAVIGATION_WIDTH = 640;

// The real page and its loading shell must choose the same columns before data
// arrives. Widths are UI units (80% is scale 1), not stored physical pixels.
export function flowPanelLayout({ section = "overview", selectedInsightId, panelWidth, scale = 1, availableWidth, viewportWidth }) {
  const width = Math.max(0, Number(availableWidth) || 0);
  const compact = width < 560 * scale;
  const hasRail = section === "overview" || section === "insights" && Boolean(selectedInsightId);
  const minWidth = 260 * scale;
  const maxWidth = Math.max(minWidth, Math.min((section === "overview" ? 480 : 600) * scale, width * (section === "overview" ? .44 : .49)));
  const defaultWidth = section === "overview" ? 364 : viewportWidth / scale <= 1100 ? 286 : 306;
  const railWidth = Math.max(minWidth, Math.min(maxWidth, (Number(panelWidth) || defaultWidth) * scale));
  const sideRail = hasRail && !compact;
  return {
    compact, sideRail, stacked: section === "overview" && compact,
    minWidth, maxWidth, railWidth,
    columns: compact ? "minmax(0, 1fr)" : `minmax(0, 1fr) ${sideRail ? 16 : 0}px ${sideRail ? railWidth : 0}px`,
  };
}
