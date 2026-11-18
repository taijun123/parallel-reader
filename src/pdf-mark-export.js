import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber } from 'pdf-lib';

const colors = {
  yellow: [1, 0.82, 0.30],
  mint: [0.24, 0.78, 0.62],
  purple: [0.62, 0.47, 0.96],
  pink: [0.94, 0.43, 0.65],
};

function fromViewport(page, x, y) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const clipped = {
    x: Math.max(media.x, crop.x),
    y: Math.max(media.y, crop.y),
    right: Math.min(media.x + media.width, crop.x + crop.width),
    top: Math.min(media.y + media.height, crop.y + crop.height),
  };
  const box = clipped.right > clipped.x && clipped.top > clipped.y
    ? { x: clipped.x, y: clipped.y, width: clipped.right - clipped.x, height: clipped.top - clipped.y }
    : media;
  const rotated = ((page.getRotation().angle % 360) + 360) % 360;
  const [left, top] = rotated === 90 ? [y, x]
    : rotated === 180 ? [1 - x, y]
      : rotated === 270 ? [1 - y, 1 - x]
        : [x, 1 - y];
  return [box.x + left * box.width, box.y + top * box.height];
}

function annotationGeometry(page, rects) {
  const quads = rects.map(({ x, y, w, h }) => [
    fromViewport(page, x, y),
    fromViewport(page, x + w, y),
    fromViewport(page, x, y + h),
    fromViewport(page, x + w, y + h),
  ]);
  const points = quads.flat();
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    quadPoints: quads.flat(2),
  };
}

function addBookmark(pdf, page, mark) {
  const { context, catalog } = pdf;
  const outlinesName = PDFName.of('Outlines');
  const name = key => PDFName.of(key);
  let rootRef = catalog.get(outlinesName);
  let root = catalog.lookupMaybe(outlinesName, PDFDict);
  if (!root) {
    root = context.obj({ Type: 'Outlines' });
    rootRef = context.register(root);
    catalog.set(outlinesName, rootRef);
  } else if (rootRef instanceof PDFDict) {
    rootRef = context.register(root);
    catalog.set(outlinesName, rootRef);
  }
  const [left, top] = mark.rects?.[0]
    ? fromViewport(page, mark.rects[0].x, mark.rects[0].y)
    : fromViewport(page, 0, 0);
  const item = context.obj({
    Title: PDFHexString.fromText(mark.note || mark.text || `第 ${mark.page} 页`),
    Parent: rootRef,
    Dest: [page.ref, 'XYZ', left, top, null],
  });
  const ref = context.register(item);
  const previous = root.get(name('Last'));
  if (previous) {
    item.set(name('Prev'), previous);
    context.lookup(previous, PDFDict).set(name('Next'), ref);
  } else {
    root.set(name('First'), ref);
  }
  root.set(name('Last'), ref);
  const count = root.lookupMaybe(name('Count'), PDFNumber)?.asNumber() || 0;
  root.set(name('Count'), PDFNumber.of(Math.abs(count) + 1));
}

function addAnnotation(pdf, page, mark) {
  const subtype = { highlight: 'Highlight', underline: 'Underline', area: 'Square', note: 'Text' }[mark.type];
  if (!subtype) return;
  const rects = mark.rects?.length ? mark.rects : [{ x: 0.035, y: 0.035, w: 0.04, h: 0.025 }];
  const noteRect = { x: rects[0].x, y: rects[0].y, w: 0.035, h: 0.025 };
  const { bounds, quadPoints } = annotationGeometry(page, subtype === 'Text' ? [noteRect] : rects);
  const data = {
    Type: 'Annot',
    Subtype: subtype,
    Rect: bounds,
    P: page.ref,
    C: colors[mark.color] || colors.yellow,
    Contents: PDFHexString.fromText([mark.note, mark.text].filter(Boolean).join('\n\n')),
    T: PDFHexString.fromText('对读'),
    F: 4,
  };
  if (subtype === 'Highlight' || subtype === 'Underline') {
    data.QuadPoints = quadPoints;
  }
  if (subtype === 'Highlight') data.CA = 0.5;
  if (subtype === 'Square') data.BS = { W: 1.5, S: 'S' };
  if (subtype === 'Text') data.Name = 'Comment';
  page.node.addAnnot(pdf.context.register(pdf.context.obj(data)));
}

export async function annotatedPdf(doc, marks) {
  let source;
  if (doc.file) source = await doc.file.arrayBuffer();
  else if (doc.getBytes) source = await doc.getBytes();
  else {
    if (!doc.path) throw new Error('无法取得原 PDF');
    const response = await fetch(`/api/pdf?path=${encodeURIComponent(doc.path)}`);
    if (!response.ok) throw new Error('无法读取原 PDF');
    source = await response.arrayBuffer();
  }
  let pdf;
  try {
    pdf = await PDFDocument.load(source, { updateMetadata: false });
  } catch (error) {
    if (error.name === 'EncryptedPDFError' || /encrypted/i.test(error.message)) {
      throw new Error('加密 PDF 无法导出标注副本，可导出 Markdown');
    }
    throw error;
  }
  const pages = pdf.getPages();
  for (const mark of marks) {
    const page = pages[mark.page - 1];
    if (!page) continue;
    if (mark.type === 'bookmark') addBookmark(pdf, page, mark);
    else addAnnotation(pdf, page, mark);
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}
