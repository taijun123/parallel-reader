export const clamp = (value, min, max) => Math.min(Math.max(min, max), Math.max(min, value));

// A continuous page coordinate makes differently sized pages scroll together.
export function pagePosition(pages, top) {
  if (!pages.length) return 0;
  let lo = 0, hi = pages.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (pages[mid].top <= top) lo = mid; else hi = mid - 1; }
  const span = pages[lo + 1] ? pages[lo + 1].top - pages[lo].top : pages[lo].height;
  return lo + (top - pages[lo].top) / Math.max(1, span);
}
export function topForPosition(pages, position) {
  if (!pages.length) return 0;
  position = clamp(position, 0, pages.length);
  const index = Math.min(Math.floor(position), pages.length - 1);
  const span = pages[index + 1] ? pages[index + 1].top - pages[index].top : pages[index].height;
  return pages[index].top + (position - index) * span;
}
