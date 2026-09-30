// Accessibility (WCAG 2.2) and design-quality signals for an inspected subtree. Pure and deterministic: the numbers
// a design critique needs next to the picture (figma_export_image), so "looks off" becomes "3 gaps off the scale".
import type { DesignSystem, NodeSnapshot } from "./types.ts";
import { weightOfStyle } from "./weights.ts";

export interface Finding { kind: "contrast" | "target-size" | "text-size" | "spacing" | "alignment" | "consistency"; severity: "error" | "warning" | "info"; nodeId?: string; node?: string; message: string }

const parseHex = (h: string): [number, number, number, number] => {
  const x = h.replace("#", "");
  const n = (i: number) => parseInt(x.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), x.length >= 8 ? n(6) / 255 : 1];
};
const lum = ([r, g, b]: number[]) => {
  const c = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
/** WCAG contrast ratio of two opaque colours. */
export const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** A translucent colour over an opaque one. */
const over = (top: [number, number, number, number], under: number[]) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3]));

const INTERACTIVE = /(?:^| )(button|btn|link|checkbox|radio|switch|toggle|tab|input|select|dropdown|chip|icon ?button|close)(?= |$)/i;
const solid = (n: NodeSnapshot) => n.fills?.find((f) => f.startsWith("#"));

export function accessibilityFindings(root: NodeSnapshot): Finding[] {
  const out: Finding[] = [];
  const walk = (n: NodeSnapshot, bgStack: string[]) => {
    if (n.visible === false) return;
    const own = n.type !== "TEXT" ? solid(n) : undefined;
    const stack = own ? [...bgStack, own] : bgStack;
    if (n.type === "TEXT" && n.text?.chars?.trim()) {
      const fg = solid(n);
      if (fg) {
        // The background: the layers under it, from the page (white) up, blending translucent ones.
        let bg: number[] = [255, 255, 255];
        for (const h of stack) bg = over(parseHex(h), bg);
        const fgc = over(parseHex(fg), bg);
        const ratio = contrast(fgc, bg);
        const size = n.text.fontSize ?? 16;
        const bold = ["bold", "extrabold", "black", "semibold"].includes(weightOfStyle((n.text.font ?? "").split(" ").slice(1).join(" ")));
        const large = size >= 24 || (size >= 18.66 && bold);
        const need = large ? 3 : 4.5;
        if (ratio < need) out.push({ kind: "contrast", severity: ratio < need - 1.5 ? "error" : "warning", nodeId: n.id, node: n.name,
          message: `Text contrast ${ratio.toFixed(2)}:1 is below ${need}:1 (${large ? "large" : "normal"} text, WCAG 1.4.3): "${n.text.chars.slice(0, 40)}"` });
      }
      if ((n.text.fontSize ?? 16) < 12) out.push({ kind: "text-size", severity: "warning", nodeId: n.id, node: n.name, message: `${n.text.fontSize}px text is hard to read; 12px is a practical minimum: "${n.text.chars.slice(0, 40)}"` });
    }
    // Things people tap: instances of interactive components, or layers named like them.
    const name = `${n.instance?.componentSet ?? ""} ${n.instance?.component ?? ""} ${n.name}`;
    if ((n.type === "INSTANCE" || n.type === "FRAME") && INTERACTIVE.test(name.replace(/[_/-]/g, " ")) && n.w && n.h) {
      const small = Math.min(n.w, n.h);
      if (small < 24) out.push({ kind: "target-size", severity: "error", nodeId: n.id, node: n.name, message: `Touch target ${Math.round(n.w)}×${Math.round(n.h)} is below the 24×24 minimum (WCAG 2.5.8).` });
      else if (small < 44) out.push({ kind: "target-size", severity: "info", nodeId: n.id, node: n.name, message: `Touch target ${Math.round(n.w)}×${Math.round(n.h)}: 44×44 is recommended for touch screens.` });
    }
    if (n.type !== "INSTANCE" || n.children) for (const c of n.children ?? []) walk(c, stack);
  };
  walk(root, []);
  return out;
}

export interface DesignMetrics {
  spacing: { values: number[]; offScale: number[]; notMultipleOf4: number[] };
  typography: { fontSizes: number[]; unstyledTexts: number; styledTexts: number };
  colors: { raw: string[]; bound: number };
  alignment: { nearMisses: number };
}

/** Countable signals of consistency, for a critique: fewer distinct values and more tokens/styles is better. */
export function designMetrics(root: NodeSnapshot, ds?: DesignSystem): { metrics: DesignMetrics; findings: Finding[] } {
  const findings: Finding[] = [];
  const spacing = new Set<number>(), sizes = new Set<number>(), raw = new Set<string>();
  let unstyled = 0, styled = 0, bound = 0, nearMisses = 0;
  const scale = new Set((ds?.variables ?? []).filter((v) => v.type === "FLOAT" && typeof v.value === "number" && /space|spacing|gap|padding/i.test(`${v.collection} ${v.name}`)).map((v) => v.value as number));
  const walk = (n: NodeSnapshot, inInstance: boolean) => {
    if (n.visible === false) return;
    if (!inInstance) {
      if (n.layout && n.layout.mode !== "NONE") {
        for (const [f, v] of [["itemSpacing", n.layout.gap], ["paddingTop", n.layout.padding?.top], ["paddingRight", n.layout.padding?.right], ["paddingBottom", n.layout.padding?.bottom], ["paddingLeft", n.layout.padding?.left]] as const) {
          if (!v) continue;
          if (n.bound?.[f]) bound++; else spacing.add(Math.round(v * 100) / 100);
        }
      }
      if (n.type === "TEXT") {
        if (n.text?.fontSize) sizes.add(n.text.fontSize);
        if (n.text?.styleId) styled++; else unstyled++;
      }
      const f = solid(n);
      if (f) { if (n.bound?.fills || n.fillStyle) bound++; else raw.add(f.toUpperCase()); }
      // Near-miss alignment: siblings in a frame without Auto Layout whose left edges are 1–3px apart.
      const kids = (n.children ?? []).filter((c) => c.visible !== false && c.x !== undefined);
      if (n.layout?.mode === "NONE" && kids.length > 1) {
        const xs = kids.map((c) => c.x!).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) { const d = xs[i] - xs[i - 1]; if (d > 0 && d <= 3) nearMisses++; }
      }
    }
    for (const c of n.children ?? []) walk(c, inInstance || n.type === "INSTANCE");
  };
  walk(root, false);
  const values = [...spacing].sort((a, b) => a - b);
  const offScale = scale.size ? values.filter((v) => !scale.has(v)) : [];
  const not4 = values.filter((v) => v % 4 !== 0 && v % 2 !== 0);
  if (offScale.length) findings.push({ kind: "spacing", severity: "warning", message: `Spacing values not on the Design System scale: ${offScale.join(", ")}px.` });
  if (not4.length) findings.push({ kind: "spacing", severity: "info", message: `Odd spacing values (not on a 4/8px rhythm): ${not4.join(", ")}px.` });
  if (sizes.size > 6) findings.push({ kind: "consistency", severity: "warning", message: `${sizes.size} different font sizes; a screen usually needs 4–6.` });
  if (unstyled && ds?.typography.length) findings.push({ kind: "consistency", severity: "info", message: `${unstyled} text layer(s) without a text style.` });
  if (raw.size > 8) findings.push({ kind: "consistency", severity: "info", message: `${raw.size} raw colours not bound to a variable or style.` });
  if (nearMisses) findings.push({ kind: "alignment", severity: "warning", message: `${nearMisses} near-miss alignment(s): edges 1–3px apart that probably should line up.` });
  return { metrics: { spacing: { values, offScale, notMultipleOf4: not4 }, typography: { fontSizes: [...sizes].sort((a, b) => a - b), unstyledTexts: unstyled, styledTexts: styled }, colors: { raw: [...raw], bound }, alignment: { nearMisses } }, findings };
}
