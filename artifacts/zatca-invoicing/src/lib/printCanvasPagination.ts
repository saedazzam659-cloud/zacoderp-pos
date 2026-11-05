/**
 * Return the last canvas row containing visible, non-white pixels.
 *
 * The PDF exporter captures the document into a canvas after expanding its
 * iframe. Browsers may include the iframe's extra viewport area as white
 * pixels; treating that tail as document content can create a nearly empty
 * final PDF page.
 */
export function findLastPaintedRow(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  whiteThreshold = 252,
): number {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) return -1;

  for (let y = height - 1; y >= 0; y--) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      if (
        pixels[i + 3] > 0 &&
        (pixels[i] < whiteThreshold ||
          pixels[i + 1] < whiteThreshold ||
          pixels[i + 2] < whiteThreshold)
      ) {
        return y;
      }
    }
  }

  return -1;
}
