// Figma → Design Plan: serialize an inspected subtree (NodeSnapshot, with expandInstances) back into the DSL, so an
// existing design can be cloned, refactored ("rebuild with the new stepper") or turned into code. Pure and deterministic.
import type { DesignSystem, NodeSnapshot } from "./types.ts";
import type { DesignPlan } from "./dsl.ts";
import { weightOfStyle } from "./weights.ts";

export interface PlanExport { plan: DesignPlan; warnings: string[] }

const ALIGN: Record<string, string> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between", BASELINE: "baseline" };
const hexOnly = (f?: string[]) => (f?.length === 1 && f[0].startsWith("#") ? f[0].toUpperCase() : undefined);

export function snapshotToPlan(root: NodeSnapshot, ds?: DesignSystem, opts: { name?: string } = {}): PlanExport {
  const warnings: string[] = [];
  const styleName = (id?: string, name?: string) => name ?? ds?.typography.find((t) => t.styleId === id)?.name;

  const size = (n: NodeSnapshot, axis: "H" | "V") => {
    const mode = axis === "H" ? n.layout?.sizingH : n.layout?.sizingV;
    if (mode === "HUG") return "hug";
    if (mode === "FILL") return "fill";
    return axis === "H" ? n.w : n.h;
  };

  const color = (n: NodeSnapshot, field: "fills" | "strokes" = "fills") => n.bound?.[field] ?? hexOnly(field === "fills" ? n.fills : n.strokes);

  const node = (n: NodeSnapshot, parent: NodeSnapshot | undefined, path: string): any => {
    if (n.visible === false) return undefined;
    // Children of a frame without Auto Layout keep their exact position. Group children are in the group's parent space.
    const inFlow = parent?.layout && parent.layout.mode !== "NONE" && parent.type !== "GROUP";
    const origin = parent?.type === "GROUP" ? { x: parent.x ?? 0, y: parent.y ?? 0 } : { x: 0, y: 0 };
    const position = parent && !inFlow && parent.type !== "SECTION" && n.x !== undefined ? { type: "absolute", x: (n.x ?? 0) - origin.x, y: (n.y ?? 0) - origin.y } : undefined;
    const common: any = { name: n.name, ...(position ? { position } : {}), ...(n.opacity !== undefined ? { opacity: n.opacity } : {}) };
    if (n.reactions?.length) common.interactions = n.reactions.map((r) => interactionOf(r, path, warnings)).filter(Boolean);
    if (n.annotations?.length) common.annotations = n.annotations;

    if (n.type === "TEXT" && n.text) {
      const t: any = { type: "text", ...common, content: n.text.chars.replace(/…$/, "") };
      const st = styleName(n.text.styleId, n.text.style);
      if (st) t.style = st;
      else {
        // "Plus Jakarta Sans Semi Bold": the trailing words that describe a weight or slant are the style.
        const words = (n.text.font ?? "Inter Regular").split(" ");
        let cut = words.length;
        while (cut > 1 && /^(thin|hairline|extra|ultra|light|regular|normal|book|medium|semi|demi|bold|black|heavy|italic|oblique|extrabold|semibold|extralight|ultralight)$/i.test(words[cut - 1])) cut--;
        t.fontFamily = words.slice(0, cut).join(" ");
        const styleWords = words.slice(cut).join(" ") || "Regular";
        t.weight = weightOfStyle(styleWords);
        if (/italic|oblique/i.test(styleWords)) t.italic = true;
        if (n.text.fontSize) t.fontSize = n.text.fontSize;
      }
      if (typeof n.text.lineHeight === "number") t.lineHeight = { unit: "px", value: n.text.lineHeight };
      if (n.text.letterSpacing) t.letterSpacing = { unit: "px", value: n.text.letterSpacing };
      const c = color(n);
      if (c) t.color = c;
      if (n.text.align && n.text.align !== "LEFT") t.align = n.text.align.toLowerCase() === "justified" ? "justified" : n.text.align.toLowerCase();
      // Single-line text hugs; wrapping text keeps its width (or fills its column).
      const w = size(n, "H");
      t.width = n.text.autoResize === "WIDTH_AND_HEIGHT" || w === "hug" ? "hug" : w === "fill" && inFlow ? "fill" : n.w;
      return t;
    }

    if (n.type === "INSTANCE" && n.instance) {
      const ref = n.instance.componentSetId ?? n.instance.componentId;
      if (!ref) { warnings.push(`${path}: instance "${n.name}" has no reachable main component; skipped.`); return undefined; }
      const props: Record<string, string | boolean> = {};
      for (const [k, v] of Object.entries(n.instance.props ?? {})) if (typeof v === "string" || typeof v === "boolean") props[k.split("#")[0]] = v;
      // Overridden text that isn't a text property: carried as a text-layer override by layer name.
      const byText = new Map<string, NodeSnapshot>();
      const collect = (x: NodeSnapshot) => { if (x.type === "TEXT") byText.set(x.name, x); (x.children ?? []).forEach(collect); };
      (n.children ?? []).forEach(collect);
      for (const [layer, fields] of Object.entries(n.instance.overrides ?? {})) {
        if (fields.includes("characters") && byText.has(layer) && !(layer in props)) props[layer] = byText.get(layer)!.text!.chars;
        if (fields.includes("visible")) warnings.push(`${path}: "${n.name}" hides layer "${layer}" by an override; plans can't express that yet.`);
      }
      const out: any = { type: "component", ...common, component: { id: ref } };
      if (n.instance.variants && n.instance.componentSetId) out.variant = n.instance.variants;
      if (Object.keys(props).length) out.props = props;
      const w = size(n, "H"), h = size(n, "V");
      if ((w === "fill" && inFlow) || typeof w === "number") out.width = w;
      if (h === "fill" && inFlow) out.height = h;
      return out;
    }

    if (["FRAME", "COMPONENT", "GROUP", "SECTION", "RECTANGLE", "ELLIPSE"].includes(n.type)) {
      const out: any = { type: n.type === "SECTION" ? "section" : "frame", ...common };
      if (n.type === "COMPONENT") warnings.push(`${path}: component "${n.name}" exported as a frame (use its instances to reuse it).`);
      const auto = n.layout && n.layout.mode !== "NONE" && n.layout.mode !== "GRID";
      if (n.type !== "SECTION") {
        out.layout = auto
          ? { direction: n.layout!.mode === "HORIZONTAL" ? "horizontal" : "vertical", gap: n.bound?.itemSpacing ?? n.layout!.gap ?? 0,
              padding: pad(n), align: ALIGN[n.layout!.primaryAlign ?? "MIN"] ?? "start", crossAlign: ALIGN[n.layout!.counterAlign ?? "MIN"] ?? "start" }
          : { direction: "none" };
        // Outside an Auto Layout flow (the root, absolute children) "fill" has nothing to fill: use the size.
        const fit = (v: number | string | undefined, px?: number) => (v === "fill" && !inFlow ? px : v);
        out.width = auto ? fit(size(n, "H"), n.w) : n.w;
        out.height = auto ? fit(size(n, "V"), n.h) : n.h;
      }
      out.fill = color(n);
      if (n.fills?.some((x) => !x.startsWith("#"))) warnings.push(`${path}: "${n.name}" has a ${n.fills.find((x) => !x.startsWith("#"))} fill; only solid colours are exported.`);
      // A section's outline and corner radius are Figma's section chrome, not design.
      const s = n.type === "SECTION" ? undefined : color(n, "strokes");
      if (s) { out.stroke = s; if (n.strokeWeight) out.strokeWeight = n.strokeWeight; }
      if (n.type === "ELLIPSE" && n.w) out.radius = n.w / 2;
      else if (n.radius && n.type !== "SECTION") out.radius = n.bound?.topLeftRadius ?? n.radius;
      if (n.clip) out.clip = true;
      if (n.truncated) warnings.push(`${path}: "${n.name}" has ${n.truncated} more children beyond the inspected depth.`);
      out.children = (n.children ?? []).map((c, i) => node(c, n, `${path}.children[${i}]`)).filter(Boolean);
      return strip(out);
    }

    warnings.push(`${path}: ${n.type.toLowerCase()} "${n.name}" can't be exported to the DSL (vectors and images need the original); skipped.`);
    return undefined;
  };

  const top = node(root, undefined, "screens[0]");
  const plan = { version: 1, name: opts.name ?? root.name, screenGap: 80, screens: top ? [top] : [] } as unknown as DesignPlan;
  return { plan, warnings };
}

const TRIG: Record<string, string> = { ON_CLICK: "click", ON_HOVER: "hover", ON_PRESS: "press", ON_DRAG: "drag", MOUSE_ENTER: "mouse-enter", MOUSE_LEAVE: "mouse-leave", AFTER_TIMEOUT: "after-delay" };
const ACT: Record<string, string> = { NAVIGATE: "navigate", OVERLAY: "overlay", SWAP: "swap", SCROLL_TO: "scroll-to", CHANGE_TO: "change-to", BACK: "back", CLOSE: "close", URL: "url" };
const EASE: Record<string, string> = { EASE_OUT: "ease-out", EASE_IN: "ease-in", EASE_IN_AND_OUT: "ease-in-out", LINEAR: "linear", EASE_IN_BACK: "ease-in-back", EASE_OUT_BACK: "ease-out-back", GENTLE: "gentle", QUICK: "quick", BOUNCY: "bouncy", SLOW: "slow" };

/** A snapshot reaction as a DSL interaction; destinations stay Figma node ids. */
function interactionOf(r: NonNullable<NodeSnapshot["reactions"]>[number], path: string, warnings: string[]) {
  const trigger = TRIG[r.trigger ?? ""], action = ACT[r.action ?? ""];
  if (!trigger || !action) { warnings.push(`${path}: a ${r.trigger ?? "?"} → ${r.action ?? "?"} interaction can't be expressed in the DSL; skipped.`); return undefined; }
  const out: any = { trigger, action };
  if (r.delay) out.delay = Math.round(r.delay * 1000);
  if (r.to) out.to = r.to;
  if (r.url) out.url = r.url;
  if (r.transition) out.transition = { type: r.transition.type.toLowerCase().replace(/_/g, "-"), ...(r.transition.direction ? { direction: r.transition.direction.toLowerCase() } : {}), duration: r.transition.duration, easing: EASE[r.transition.easing ?? ""] ?? "ease-out" };
  return out;
}

function pad(n: NodeSnapshot) {
  const p = n.layout?.padding;
  if (!p) return 0;
  const v = (k: "top" | "right" | "bottom" | "left", f: string) => n.bound?.[f] ?? p[k];
  const out = { top: v("top", "paddingTop"), right: v("right", "paddingRight"), bottom: v("bottom", "paddingBottom"), left: v("left", "paddingLeft") };
  const vals = Object.values(out);
  return vals.every((x) => x === vals[0]) ? vals[0] : out;
}

function strip(v: any): any {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, strip(x)]));
  return v;
}
