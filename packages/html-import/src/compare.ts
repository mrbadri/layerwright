// Visual checks: a screenshot of the source HTML, and a pixel diff of two images. Both run in the Chromium the
// importer already uses, so there are no image libraries to install.
import { launch, withPage } from "./browser.ts";

/** PNG (base64) of an element of a rendered HTML page, at CSS pixel size. */
export async function screenshotHtml(path: string, opts: { selector?: string; width?: number; height?: number; root?: string } = {}): Promise<{ base64: string; width: number; height: number; contentHeight?: number }> {
  return withPage(path, { root: opts.root, width: opts.width ?? 1440, height: 900 }, async (page) => {
    // The whole page, cut to the height being compared (a screen is at least the viewport tall, or hugs its content).
    if (!opts.selector && opts.height) {
      // Where the content ends (scrollHeight is never less than the viewport).
      const contentHeight = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().bottom + window.scrollY));
      const width = opts.width ?? 1440;
      const height = Math.max(1, Math.round(opts.height));
      const buf = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width, height }, animations: "disabled" });
      return { base64: buf.toString("base64"), width, height, contentHeight };
    }
    const el = page.locator(opts.selector ?? "body").first();
    const box = await el.boundingBox();
    if (!box) throw new Error(`Nothing rendered for "${opts.selector ?? "body"}".`);
    const buf = await el.screenshot({ animations: "disabled" });
    return { base64: buf.toString("base64"), width: Math.round(box.width), height: Math.round(box.height) };
  });
}

export interface ImageDiff {
  /** Share of 24px cells with a noticeable change, 0–1. Unlike a pixel share, empty background can't dilute it. */
  changedCells: number;
  /** Changed areas (merged neighbouring cells), largest first, in A's pixels. */
  regions: { x: number; y: number; w: number; h: number }[];
  sizeA: { width: number; height: number };
  sizeB: { width: number; height: number };
  /** PNG (base64) with differing pixels in red over a faded copy of A. */
  heatmap: string;
}

/** Compare two images at their natural size, aligned top-left. A pixel counts as changed only when no pixel of the
 *  other image within 1px matches it (tolerates anti-aliasing and sub-pixel text shifts). */
export async function diffImages(a: { base64: string; mime?: string }, b: { base64: string; mime?: string }): Promise<ImageDiff> {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript("window.__name = (f) => f"); // tsx/esbuild wraps inner functions in __name()
    await page.goto("about:blank");
    return await page.evaluate(async ({ a, b }) => {
      const load = (src: string) => new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("image failed to decode")); i.src = src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.max(ia.naturalWidth, ib.naturalWidth), h = Math.max(ia.naturalHeight, ib.naturalHeight);
      const px = (img: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
      const A = px(ia), B = px(ib);
      const T = 48;
      const near = (i: number, j: number) => Math.abs(A[i] - B[j]) <= T && Math.abs(A[i + 1] - B[j + 1]) <= T && Math.abs(A[i + 2] - B[j + 2]) <= T;
      const out = document.createElement("canvas"); out.width = w; out.height = h;
      const og = out.getContext("2d")!; const heat = og.createImageData(w, h);
      const C = 24, cw = Math.ceil(w / C), ch = Math.ceil(h / C);
      const cellHits = new Uint32Array(cw * ch);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let hit = !near(i, i);
        if (hit) search: for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
          if (near(i, (yy * w + xx) * 4)) { hit = false; break search; }
        }
        if (hit) cellHits[Math.floor(y / C) * cw + Math.floor(x / C)]++;
        const grey = 255 - (255 - (A[i] + A[i + 1] + A[i + 2]) / 3) * 0.25;
        heat.data[i] = hit ? 230 : grey; heat.data[i + 1] = hit ? 30 : grey; heat.data[i + 2] = hit ? 30 : grey; heat.data[i + 3] = 255;
      }
      og.putImageData(heat, 0, 0);
      // A cell changed when more than 4% of it differs; neighbouring changed cells merge into regions.
      const changed = new Uint8Array(cw * ch);
      let count = 0;
      for (let k = 0; k < changed.length; k++) if (cellHits[k] > C * C * 0.04) { changed[k] = 1; count++; }
      const seen = new Uint8Array(cw * ch);
      const regions: { x: number; y: number; w: number; h: number; n: number }[] = [];
      for (let k = 0; k < changed.length; k++) {
        if (!changed[k] || seen[k]) continue;
        let x0 = cw, y0 = ch, x1 = 0, y1 = 0, n = 0;
        const stack = [k]; seen[k] = 1;
        while (stack.length) {
          const q = stack.pop()!; const qx = q % cw, qy = Math.floor(q / cw); n++;
          x0 = Math.min(x0, qx); y0 = Math.min(y0, qy); x1 = Math.max(x1, qx); y1 = Math.max(y1, qy);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = qx + dx, ny = qy + dy, nq = ny * cw + nx;
            if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && changed[nq] && !seen[nq]) { seen[nq] = 1; stack.push(nq); }
          }
        }
        regions.push({ x: x0 * C, y: y0 * C, w: Math.min(w, (x1 + 1) * C) - x0 * C, h: Math.min(h, (y1 + 1) * C) - y0 * C, n });
      }
      regions.sort((p, q) => q.n - p.n);
      return { changedCells: Math.round((count / changed.length) * 10000) / 10000, regions: regions.slice(0, 8).map(({ n, ...r }) => r),
        sizeA: { width: ia.naturalWidth, height: ia.naturalHeight }, sizeB: { width: ib.naturalWidth, height: ib.naturalHeight }, heatmap: out.toDataURL("image/png").split(",")[1] };
    }, { a: `data:${a.mime ?? "image/png"};base64,${a.base64}`, b: `data:${b.mime ?? "image/png"};base64,${b.base64}` });
  } finally { await browser.close(); }
}
