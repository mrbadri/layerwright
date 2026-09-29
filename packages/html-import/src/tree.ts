// HTML → Figma node tree (pixel-faithful, absolute layers; used by figma_import_html). Renders a prototype in headless Chrome and serializes what the browser
// actually painted (boxes, computed styles, text runs, inline SVG). No model tokens are spent on layout.
import type { ImportNode } from "@cde/core";
import { withPage } from "./browser.ts";

export interface ImportTarget { selector: string; name?: string; index?: number }
/** Replace matching elements with instances of an existing component. Variant = first rule whose test matches
 *  (a CSS selector inside the element, or "text:<substring>"); otherwise `default`. */
export interface ImportSwap { selector: string; component: string; id?: string; key?: string; variants?: { test: string; variant: string }[]; default?: string; overrides?: "none" | "text" | "match"; fills?: boolean }
export interface ImportAction { click: string; index?: number; waitMs?: number }
export interface ImportedScreen { name: string; width: number; height: number; tree: ImportNode; nodeCount: number }

export async function importHtml(opts: { file: string; root?: string; targets?: ImportTarget[]; swaps?: ImportSwap[]; actions?: ImportAction[]; viewport?: number; waitMs?: number }): Promise<ImportedScreen[]> {
  return withPage(opts.file, { root: opts.root, width: opts.viewport ?? 2400, height: 1200, waitMs: opts.waitMs ?? 1500 }, async (page) => {
    for (const a of opts.actions ?? []) {
      await page.locator(a.click).nth(a.index ?? 0).click();
      await page.waitForTimeout(a.waitMs ?? 300);
    }
    return (await page.evaluate(SERIALIZE, { targets: opts.targets ?? null, swaps: opts.swaps ?? [] })) as ImportedScreen[];
  });
}

// Runs inside the page. Kept dependency-free and self-contained.
const SERIALIZE = ({ targets, swaps }: { targets: ImportTarget[] | null; swaps: ImportSwap[] }) => {
  const px = (v: string) => parseFloat(v) || 0;
  const color = (v: string): { hex: string; a: number } | null => {
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean);
    const al = parseFloat(a);
    if (al === 0) return null;
    const h = (n: string) => Math.round(+n).toString(16).padStart(2, "0");
    return { hex: `#${h(r)}${h(g)}${h(b)}`.toUpperCase(), a: al };
  };
  const splitTop = (s: string) => { const out: string[] = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const gradient = (bg: string): any => {
    const m = bg.match(/^linear-gradient\((.*)\)$/);
    if (!m) return null;
    const parts = splitTop(m[1]);
    let angle = 180;
    if (/deg$/.test(parts[0])) angle = parseFloat(parts.shift()!);
    else if (/^to /.test(parts[0])) { const t = parts.shift()!; angle = ({ "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 } as any)[t] ?? 180; }
    const stops = parts.map((p, i) => {
      const cm = p.match(/rgba?\([^)]+\)/); const c = cm ? color(cm[0]) : null;
      const pos = p.replace(cm?.[0] ?? "", "").match(/([\d.]+)%/);
      return c && { hex: c.hex, a: c.a, pos: pos ? +pos[1] / 100 : i / Math.max(1, parts.length - 1) };
    }).filter(Boolean);
    return stops.length >= 2 ? { angle, stops } : null;
  };
  const shadows = (v: string) => {
    if (!v || v === "none") return undefined;
    return splitTop(v).map((s) => {
      const cm = s.match(/rgba?\([^)]+\)/); const c = cm ? color(cm[0]) : null;
      const nums = s.replace(cm?.[0] ?? "", "").replace("inset", "").trim().split(/\s+/).map(px);
      return c && { inset: /inset/.test(s), x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, hex: c.hex, a: c.a };
    }).filter(Boolean);
  };
  const weightStyle = (w: string) => ({ "100": "Thin", "200": "ExtraLight", "300": "Light", "400": "Regular", "500": "Medium", "600": "SemiBold", "700": "Bold", "800": "ExtraBold", "900": "Black" } as any)[String(Math.round(+w / 100) * 100)] ?? "Regular";
  const family = (f: string) => f.split(",")[0].replace(/["']/g, "").trim();

  let count = 0;
  const nameOf = (el: Element) => el.getAttribute("aria-label") || el.getAttribute("data-name") || el.getAttribute("role") || el.tagName.toLowerCase();

  function svgNode(el: SVGSVGElement, ox: number, oy: number) {
    const r = el.getBoundingClientRect();
    const clone = el.cloneNode(true) as SVGSVGElement;
    const src = [el, ...el.querySelectorAll("*")] as Element[];
    const dst = [clone, ...clone.querySelectorAll("*")] as Element[];
    src.forEach((s, i) => {
      const cs = getComputedStyle(s); const d = dst[i];
      d.removeAttribute("style"); d.removeAttribute("class");
      if (i === 0) return;
      const f = color(cs.fill); const st = color(cs.stroke);
      d.setAttribute("fill", f ? f.hex : "none");
      if (f && f.a < 1) d.setAttribute("fill-opacity", String(f.a));
      if (st) { d.setAttribute("stroke", st.hex); d.setAttribute("stroke-width", String(px(cs.strokeWidth))); d.setAttribute("stroke-linecap", cs.strokeLinecap); d.setAttribute("stroke-linejoin", cs.strokeLinejoin); }
    });
    clone.setAttribute("width", String(r.width)); clone.setAttribute("height", String(r.height));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    count++;
    return { type: "svg", name: el.getAttribute("aria-label") || "art", x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, svg: clone.outerHTML };
  }

  function textNodes(el: Element, ox: number, oy: number, cs: CSSStyleDeclaration) {
    const out: any[] = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent || !n.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (!r.width) continue;
      const c = color(cs.color);
      let content = n.textContent.replace(/\s+/g, " ").trim();
      if (cs.textTransform === "uppercase") content = content.toUpperCase();
      const lines = range.getClientRects().length > 1;
      count++;
      out.push({
        type: "text", name: content.slice(0, 40), x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, content,
        font: { family: family(cs.fontFamily), style: weightStyle(cs.fontWeight) }, size: px(cs.fontSize),
        lineHeight: cs.lineHeight === "normal" ? undefined : px(cs.lineHeight), letterSpacing: px(cs.letterSpacing) || undefined,
        color: c?.hex, opacity: c && c.a < 1 ? c.a : undefined,
        align: lines ? ({ right: "RIGHT", end: "RIGHT", center: "CENTER", left: "LEFT", start: cs.direction === "rtl" ? "RIGHT" : "LEFT" } as any)[cs.textAlign] ?? "RIGHT" : (cs.direction === "rtl" ? "RIGHT" : "LEFT"),
        wrap: lines,
      });
    }
    return out;
  }

  function walk(el: Element, ox: number, oy: number, isRoot: boolean): any[] {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return [];
    if (el.tagName.toLowerCase() === "svg") return [svgNode(el as SVGSVGElement, ox, oy)];
    const r = el.getBoundingClientRect();
    if (!isRoot && (r.width === 0 || r.height === 0) && cs.overflow !== "visible") return [];
    const bg = color(cs.backgroundColor);
    const grad = gradient(cs.backgroundImage);
    const notch = /radial-gradient/.test(cs.backgroundImage) ? color((cs.backgroundImage.match(/rgba?\([^)]+\)\s+[\d.]+px\)$/) || [""])[0].replace(/\s+[\d.]+px\)$/, "")) : null;
    const sh = shadows(cs.boxShadow);
    const bw = ["Top", "Right", "Bottom", "Left"].map((s) => (cs as any)[`border${s}Style`] !== "none" ? px((cs as any)[`border${s}Width`]) : 0);
    const bc = color(cs.borderTopColor) || color(cs.borderRightColor) || color(cs.borderBottomColor) || color(cs.borderLeftColor);
    const radius = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(px);
    const clip = cs.overflow === "hidden" || cs.overflowX === "hidden";
    const blend = cs.mixBlendMode !== "normal" ? cs.mixBlendMode : undefined;
    const opacity = +cs.opacity < 1 ? +cs.opacity : undefined;
    const tag = el.tagName.toLowerCase();

    if (notch) { count++; const w = r.width, h = r.height; return [{ type: "svg", name: "notch-fillet", x: r.left - ox, y: r.top - oy, w, h, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="M0 0A${w} ${h} 0 0 0 ${w} ${h}L0 ${h}Z" fill="${notch.hex}"/></svg>` }]; }

    const visual = isRoot || (cs.display !== "contents" && swaps.some((s) => el.matches(s.selector))) || bg || grad || sh || bw.some(Boolean) || clip || blend || opacity !== undefined || tag === "image-slot";
    const kids: any[] = [];
    const cx = visual ? r.left : ox, cy = visual ? r.top : oy;
    if (tag !== "image-slot") {
      kids.push(...textNodes(el, cx, cy, cs));
      for (const c of el.children) kids.push(...walk(c, cx, cy, false));
    }
    if (!visual) return kids;
    count++;
    const swap = isRoot ? undefined : swaps.find((s) => el.matches(s.selector));
    const swapInfo = swap && {
      component: swap.component, id: swap.id, key: swap.key, overrides: swap.overrides, fills: swap.fills,
      variant: swap.variants?.find((v) => v.test.startsWith("text:") ? (el.textContent ?? "").includes(v.test.slice(5)) : !!el.querySelector(v.test))?.variant ?? swap.default,
    };
    const node: any = {
      type: "frame", name: tag === "image-slot" ? "image" : nameOf(el), x: r.left - ox, y: r.top - oy, w: r.width, h: r.height,
      fill: bg ? { hex: bg.hex, a: bg.a } : undefined, gradient: grad || undefined, shadows: sh,
      stroke: bw.some(Boolean) && bc ? { hex: bc.hex, a: bc.a, weights: bw } : undefined,
      radius: radius.some(Boolean) ? radius : undefined, clip, blend, opacity, children: kids,
    };
    if (swapInfo) node.swap = swapInfo;
    if (tag === "image-slot") node.placeholder = el.getAttribute("placeholder") || "image";
    return [node];
  }

  let roots: { el: Element; name: string }[];
  if (targets) roots = targets.flatMap((t) => {
    let els = [...document.querySelectorAll(t.selector)];
    if (t.index !== undefined) els = els.slice(t.index, t.index + 1);
    return els.map((el, i, all) => ({ el, name: t.name ? (all.length > 1 ? `${t.name} ${i + 1}` : t.name) : nameOf(el) }));
  });
  else {
    // Default: every nested prototype screen on a review board, named by the label above it.
    roots = [...document.querySelectorAll(".sc-host .sc-host")].map((el) => {
      let host: Element = el;
      const p = el.parentElement!;
      if (getComputedStyle(p).overflow === "hidden" && p.children.length === 1) host = p;
      const label = host.previousElementSibling?.textContent?.trim();
      return { el: host, name: label || (el as HTMLElement).dataset.scName || "Screen" };
    });
    if (!roots.length) roots = [{ el: document.body, name: document.title || "Screen" }];
  }
  return roots.map(({ el, name }) => {
    count = 0;
    const r = el.getBoundingClientRect();
    const [tree] = walk(el, r.left, r.top, true);
    tree.x = 0; tree.y = 0; tree.name = name;
    return { name, width: r.width, height: r.height, tree, nodeCount: count };
  });
};
