// A drawing-buffer budget, independent of user-agent strings or map contents.
// Geometry, materials and depth-tested fog remain unchanged.
export function chooseRenderPolicy({ width, height, devicePixelRatio = 1, coarsePointer = false,
  maxTextureSize = Infinity, maxRenderbufferSize = Infinity } = {}) {
  const dimension = value => Number.isFinite(value) && value > 0 ? value : 1;
  const limit = value => Number.isFinite(value) && value >= 1 ? value : Infinity;
  const cssWidth = dimension(width), cssHeight = dimension(height);
  const requestedRatio = Math.min(dimension(devicePixelRatio), 2);
  const pixelBudget = coarsePointer ? 2_000_000 : 4_000_000;
  const maxDimension = Math.min(limit(maxTextureSize), limit(maxRenderbufferSize));
  const pixelRatio = Math.min(requestedRatio, Math.sqrt(pixelBudget / (cssWidth * cssHeight)),
    maxDimension / cssWidth, maxDimension / cssHeight);
  return { pixelRatio, pixelBudget, requestedRatio, coarsePointer: Boolean(coarsePointer),
    drawingWidth: Math.max(1, Math.floor(cssWidth * pixelRatio)),
    drawingHeight: Math.max(1, Math.floor(cssHeight * pixelRatio)) };
}

// Diagnostic names are deliberately bounded; driver messages can contain URLs.
export function renderErrorName(error) {
  return ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'InvalidStateError', 'OperationError'].includes(error?.name)
    ? error.name : 'Error';
}
