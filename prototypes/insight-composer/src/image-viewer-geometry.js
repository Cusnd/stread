// Viewer.js positions the scaled image before rotating it around its center.
// Fit the rotated bounds between the gallery controls, then return that image's
// unrotated top-left for zoomTo(ratio) followed by moveTo(x, y).
export function getImageViewerFit({ width, height, rotation = 0, viewportWidth, viewportHeight } = {}) {
  if (![width, height, viewportWidth, viewportHeight].every((value) => Number.isFinite(value) && value > 0) || !Number.isFinite(rotation)) return null;

  // On very small windows keep at least half of each axis available, retaining
  // the toolbar's unequal top/bottom spacing in the same proportions.
  const horizontalInset = Math.min(72, viewportWidth / 4);
  const verticalInsetScale = Math.min(1, viewportHeight / (2 * (64 + 104)));
  const top = 64 * verticalInsetScale, bottom = 104 * verticalInsetScale;
  const availableWidth = viewportWidth - 2 * horizontalInset;
  const availableHeight = viewportHeight - top - bottom;
  const radians = (rotation % 360) * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians)), sine = Math.abs(Math.sin(radians));
  const rotatedWidth = width * cosine + height * sine;
  const rotatedHeight = width * sine + height * cosine;
  const ratio = Math.min(1, availableWidth / rotatedWidth, availableHeight / rotatedHeight);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;

  return {
    ratio,
    x: (viewportWidth - width * ratio) / 2,
    y: top + (availableHeight - height * ratio) / 2,
  };
}
