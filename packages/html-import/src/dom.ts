// Reads the rendered DOM into a plain, layout-aware tree (DomNode). Runs in the page; convert.ts
// turns it into the Design DSL. Everything here is computed style + boxes, so it is deterministic.
import type { Page } from "playwright-core";

export interface Rgba { hex: string; a: number }
export interface DomBox { x: number; y: number; w: number; h: number }
export interface DomStyle {
  display: string; position: string; direction: "ltr" | "rtl";
  flexDirection?: string; flexWrap?: string; justify?: string; alignItems?: string; alignSelf?: string; flexGrow?: number;
  rowGap?: number; columnGap?: number; padding: [number, number, number, number];
  bg?: Rgba; gradient?: { angle: number; stops: { color: Rgba; position: number }[] };
  border?: { widths: [number, number, number, number]; color: Rgba };
  radius?: number; shadows?: { inset: boolean; x: number; y: number; blur: number; spread: number; color: Rgba }[];
  opacity?: number; clip?: boolean;
  font?: { family: string; weight: number; size: number; lineHeight?: number; letterSpacing?: number; italic: boolean; color?: Rgba; align: string; transform?: string };
  objectFit?: string;
}
export interface DomNode {
  kind: "element" | "text" | "svg" | "image";
  tag: string; name: string; box: DomBox; style: DomStyle;
  text?: string; lines?: number; svg?: string; src?: string;
  attrs: { role?: string; type?: string; placeholder?: string; value?: string; ariaLabel?: string; href?: string; id?: string; testid?: string };
  children: DomNode[];
}

export async function readDom(page: Page, selector = "body"): Promise<DomNode> {
  const root = await page.evaluate(SERIALIZE_DOM, selector);
  if (!root) throw new Error(`Nothing rendered for "${selector}".`);
  return root as DomNode;
}

const SERIALIZE_DOM = (selector: string) => {
  const px = (v: string) => parseFloat(v) || 0;
  const rgba = (v: string) => {
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return undefined;
    const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean);
    const al = parseFloat(a);
    if (!(al > 0)) return undefined;
    const h = (n: string) => Math.max(0, Math.min(255, Math.round(+n))).toString(16).padStart(2, "0");
    return { hex: `#${h(r)}${h(g)}${h(b)}`.toUpperCase(), a: Math.round(al * 1000) / 1000 };
  };
  const splitTop = (s: string) => { const out: string[] = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const gradient = (bg: string) => {
    const m = bg.match(/^linear-gradient\((.*)\)$/);
    if (!m) return undefined;
    const parts = splitTop(m[1]);
    let angle = 180;
    if (/deg$/.test(parts[0])) angle = parseFloat(parts.shift()!);
    else if (/^to /.test(parts[0])) angle = ({ "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 } as Record<string, number>)[parts.shift()!] ?? 180;
    const stops = parts.map((p, i) => {
      const cm = p.match(/rgba?\([^)]+\)/); const color = cm ? rgba(cm[0]) : undefined;
      const pos = p.replace(cm?.[0] ?? "", "").match(/([\d.]+)%/);
      return color && { color, position: pos ? +pos[1] / 100 : i / Math.max(1, parts.length - 1) };
    }).filter(Boolean) as { color: any; position: number }[];
    return stops.length >= 2 ? { angle, stops } : undefined;
  };
  const shadows = (v: string) => {
    if (!v || v === "none") return undefined;
    const out = splitTop(v).map((s) => {
      const cm = s.match(/rgba?\([^)]+\)/); const color = cm ? rgba(cm[0]) : undefined;
      const n = s.replace(cm?.[0] ?? "", "").replace("inset", "").trim().split(/\s+/).map(px);
      return color && { inset: /inset/.test(s), x: n[0] || 0, y: n[1] || 0, blur: n[2] || 0, spread: n[3] || 0, color };
    }).filter(Boolean);
    return out.length ? out : undefined;
  };
  const family = (f: string) => f.split(",")[0].replace(/["']/g, "").trim();
  const nameOf = (el: Element) => el.getAttribute("aria-label") || el.getAttribute("data-name") || (el.id ? `#${el.id}` : "") || (typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : "") || el.tagName.toLowerCase();

  const styleOf = (el: Element, cs: CSSStyleDeclaration) => {
    const bw = (["Top", "Right", "Bottom", "Left"] as const).map((s) => ((cs as any)[`border${s}Style`] !== "none" ? px((cs as any)[`border${s}Width`]) : 0)) as [number, number, number, number];
    const sideColors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
    const bc = rgba(sideColors[bw.findIndex((w) => w > 0)] ?? "");
    const radius = Math.max(px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius), px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius));
    return {
      display: cs.display, position: cs.position, direction: cs.direction === "rtl" ? "rtl" : "ltr",
      flexDirection: cs.flexDirection, flexWrap: cs.flexWrap, justify: cs.justifyContent, alignItems: cs.alignItems, alignSelf: cs.alignSelf, flexGrow: px(cs.flexGrow) || undefined,
      rowGap: px(cs.rowGap) || undefined, columnGap: px(cs.columnGap) || undefined,
      padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
      bg: rgba(cs.backgroundColor), gradient: gradient(cs.backgroundImage),
      border: bw.some(Boolean) && bc ? { widths: bw, color: bc } : undefined,
      radius: radius || undefined, shadows: shadows(cs.boxShadow),
      opacity: +cs.opacity < 1 ? +cs.opacity : undefined, clip: cs.overflow === "hidden" || cs.overflowX === "hidden" || undefined,
      font: {
        family: family(cs.fontFamily), weight: +cs.fontWeight || 400, size: px(cs.fontSize),
        lineHeight: cs.lineHeight === "normal" ? undefined : px(cs.lineHeight), letterSpacing: px(cs.letterSpacing) || undefined,
        italic: cs.fontStyle === "italic", color: rgba(cs.color), align: cs.textAlign, transform: cs.textTransform !== "none" ? cs.textTransform : undefined,
      },
      objectFit: el.tagName === "IMG" ? cs.objectFit : undefined,
    };
  };

  const attrs = (el: Element) => ({
    role: el.getAttribute("role") ?? undefined, type: el.getAttribute("type") ?? undefined,
    placeholder: el.getAttribute("placeholder") ?? undefined, value: (el as HTMLInputElement).value || undefined,
    ariaLabel: el.getAttribute("aria-label") ?? undefined, href: el.getAttribute("href") ?? undefined,
    id: el.id || undefined, testid: el.getAttribute("data-testid") ?? undefined,
  });

  const svgMarkup = (el: SVGSVGElement, r: DOMRect) => {
    const clone = el.cloneNode(true) as SVGSVGElement;
    const src = [el, ...el.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
    src.forEach((s, i) => {
      const cs = getComputedStyle(s), d = dst[i];
      d.removeAttribute("style"); d.removeAttribute("class");
      if (i === 0) return;
      const f = rgba(cs.fill), st = rgba(cs.stroke);
      d.setAttribute("fill", f ? f.hex : "none");
      if (f && f.a < 1) d.setAttribute("fill-opacity", String(f.a));
      if (st) { d.setAttribute("stroke", st.hex); d.setAttribute("stroke-width", String(px(cs.strokeWidth))); d.setAttribute("stroke-linecap", cs.strokeLinecap); d.setAttribute("stroke-linejoin", cs.strokeLinejoin); }
    });
    clone.setAttribute("width", String(r.width)); clone.setAttribute("height", String(r.height));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return clone.outerHTML;
  };

  const walk = (el: Element, ox: number, oy: number): any => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return null;
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "template", "noscript", "head", "meta", "link"].includes(tag)) return null;
    if ((r.width < 0.5 || r.height < 0.5) && cs.overflow !== "visible") return null;
    const box = { x: r.left - ox, y: r.top - oy, w: r.width, h: r.height };
    const base = { tag, name: nameOf(el), box, style: styleOf(el, cs), attrs: attrs(el), children: [] as any[] };
    if (tag === "svg") return { ...base, kind: "svg", svg: svgMarkup(el as SVGSVGElement, r) };
    if (tag === "img") {
      const img = el as HTMLImageElement;
      let src = img.currentSrc || img.src;
      // Local images become data URLs here (the page can read them); remote https stays a URL for the server to fetch.
      if (src && !/^https:/.test(src) && img.complete && img.naturalWidth) {
        try { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d")!.drawImage(img, 0, 0); src = c.toDataURL("image/png"); } catch { /* tainted canvas: keep the URL */ }
      }
      return { ...base, kind: "image", src };
    }
    if (["input", "textarea", "select"].includes(tag)) {
      const i = el as HTMLInputElement;
      const shown = i.value || i.placeholder || (tag === "select" ? (el as HTMLSelectElement).selectedOptions[0]?.text : "") || "";
      if (shown) base.children.push({ kind: "text", tag: "#text", name: shown.slice(0, 40), box: (() => { const lh = cs.lineHeight === "normal" ? px(cs.fontSize) * 1.25 : px(cs.lineHeight); const bl = px(cs.borderLeftWidth), br = px(cs.borderRightWidth); return { x: px(cs.paddingLeft) + bl, y: Math.max(0, (r.height - lh) / 2), w: Math.max(1, r.width - px(cs.paddingLeft) - px(cs.paddingRight) - bl - br), h: lh }; })(), style: { ...base.style, font: { ...base.style.font, color: i.value ? base.style.font.color : rgba(getComputedStyle(el, "::placeholder").color) ?? base.style.font.color } }, text: shown, lines: 1, attrs: {}, children: [] });
      return { ...base, kind: "element" };
    }
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const raw = n.textContent ?? "";
        if (!raw.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(n);
        const tr = range.getBoundingClientRect();
        if (!tr.width) continue;
        let text = raw.replace(/\s+/g, " ").trim();
        if (cs.textTransform === "uppercase") text = text.toUpperCase();
        else if (cs.textTransform === "lowercase") text = text.toLowerCase();
        base.children.push({ kind: "text", tag: "#text", name: text.slice(0, 40), box: { x: tr.left - r.left, y: tr.top - r.top, w: tr.width, h: tr.height }, style: base.style, text, lines: range.getClientRects().length, attrs: {}, children: [] });
      } else if (n.nodeType === 1) {
        const c = walk(n as Element, r.left, r.top);
        if (c) base.children.push(c);
      }
    }
    return { ...base, kind: "element" };
  };

  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const root = walk(el, r.left, r.top);
  if (root) { root.box.x = 0; root.box.y = 0; root.box.h = Math.max(root.box.h, document.documentElement.scrollHeight); }
  return root;
};
