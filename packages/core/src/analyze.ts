// Mode B: compare an existing design (compact snapshot) against the Design System and
// propose non-destructive transformations. Pure & deterministic; nothing is applied here.
import type { DesignSystem, NodeSnapshot, Transformation, TypographyDefinition, VariableDefinition, ResolvedNode, StructuredError } from "./types.ts";
import { Resolver, hash, mappingDoubt } from "./resolver.ts";
import { norm } from "./semantics.ts";
import { weightOfStyle } from "./weights.ts";

const BUTTON_NAME = /(?:^| )(button|btn|cta|دکمه)(?= |$)/;
const INPUT_NAME = /(?:^| )(input|text ?field|textfield|textbox|field|ورودی)(?= |$)/;

const isLight = (hex: string) => {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 230;
};

function texts(n: NodeSnapshot, depth = 3): NodeSnapshot[] {
  if (n.type === "TEXT") return [n];
  if (depth === 0 || !n.children) return [];
  return n.children.flatMap((c) => texts(c, depth - 1));
}

export interface AnalysisResult {
  analysisId: string;
  transformations: Transformation[];
  summary: string[];
  /** The summary as groups the user can pick or exclude by id (g1, g2, …). */
  groups?: { id: string; label: string; count: number; ids: string[] }[];
  unresolved: StructuredError[];
}

const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** Rough colour distance (0–441); good enough to tell a violet button from a pale one. */
const colorDist = (a?: string, b?: string) => {
  if (!a || !b) return a || b ? 200 : 0;
  const [x, y] = [hexRgb(a), hexRgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
const PERSIAN = /[\u0600-\u06FF]/;

/** Analysis options. `sync` = matching a fresh import (e.g. from HTML) to the Design System: text styles by size and
 *  weight (the import's font may be a stand-in), variants chosen by how the element looks, pills as badges. */
export interface AnalyzeOptions { mode?: "audit" | "sync" }

export function analyzeDesign(ds: DesignSystem, root: NodeSnapshot, opts: AnalyzeOptions = {}): AnalysisResult {
  const sync = opts.mode === "sync";
  const r = new Resolver(ds);
  const out: Transformation[] = [];
  const unresolved: StructuredError[] = [];
  let seq = 0;
  const id = () => `t${++seq}`;
  const warnings: string[] = [];

  const floatVars = ds.variables.filter((v) => v.type === "FLOAT" && typeof v.value === "number");
  const spacingAll = floatVars.filter((v) => /space|spacing|gap|padding|inset|stack|gutter/i.test(`${v.collection} ${v.name}`) || v.scopes?.includes("GAP"));
  // A spacing scale is mostly multiples of 2 (4, 8, 12, 16, …). An odd one-off (e.g. "item spacing/9", made while
  // matching an import) is not a token to spread through a design, so it's never suggested on such a scale.
  const even = spacingAll.filter((v) => (v.value as number) % 2 === 0).length;
  const onScale = even >= 3 && even >= spacingAll.length * 0.7;
  const spacingVars = onScale ? spacingAll.filter((v) => (v.value as number) % 2 === 0) : spacingAll;
  const radiusVars = floatVars.filter((v) => /radius|radii|corner|rounded/i.test(`${v.collection} ${v.name}`) || v.scopes?.includes("CORNER_RADIUS"));
  const colorVars = ds.variables.filter((v) => v.type === "COLOR" && typeof v.value === "string");
  const pickNum = (pool: VariableDefinition[], value: number) => pool.filter((v) => v.value === value).sort((a, b) => a.name.length - b.name.length)[0];
  const pickColor = (hex: string) => {
    const h = hex.toLowerCase().slice(0, 7);
    const m = colorVars.filter((v) => String(v.value).toLowerCase().slice(0, 7) === h && (String(v.value).length === 7 || String(v.value).toLowerCase().endsWith("ff")));
    // Prefer semantic tokens (bg/text/border…) over primitive palette entries.
    return m.sort((a, b) => Number(/(bg|background|surface|text|fg|border|primary|brand)/i.test(b.name)) - Number(/(bg|background|surface|text|fg|border|primary|brand)/i.test(a.name)) || a.name.length - b.name.length)[0];
  };
  const pickTextStyle = (n: NodeSnapshot): TypographyDefinition | undefined => {
    const size = n.text?.fontSize;
    if (!size) return undefined;
    const font = (n.text?.font ?? "").toLowerCase();
    // Only exact matches: a style that changes size, weight or leading would change how the text looks.
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    const lh = (v: unknown) => (typeof v === "number" ? Math.round(v * 10) / 10 : v ?? "AUTO");
    return ds.typography.find((t) => t.fontSize === size && font && norm(`${t.fontFamily}${t.fontStyle}`) === norm(font)
      && (n.text?.lineHeight === undefined || lh(t.lineHeight) === lh(n.text.lineHeight)));
  };

  /** Sync: typography by size and weight, ignoring a stand-in font; Persian text prefers Persian styles. */
  const looseTextStyle = (n: NodeSnapshot): TypographyDefinition | undefined => {
    const size = n.text?.fontSize;
    if (!size) return undefined;
    const weight = weightOfStyle((n.text?.font ?? "").split(" ").slice(1).join(" ") || "Regular");
    const fa = PERSIAN.test(n.text?.chars ?? "");
    const isFaStyle = (t: TypographyDefinition) => /(^| )fa( |\/)|yekan|vazir|iran/i.test(`${t.name} ${t.fontFamily}`);
    const lh = typeof n.text?.lineHeight === "number" ? n.text.lineHeight : undefined;
    // Library styles often report no font: the style name carries the weight ("Fa Text sm/Bold", "…/Normal").
    const styleWeight = (t: TypographyDefinition) => weightOfStyle(t.fontStyle || t.name.split("/").pop() || "");
    // The script matters more than an exact weight: Persian text takes the nearest-weight Persian style (a DS may
    // have no Fa SemiBold), and only falls back to the other script's styles when that size has none.
    const W = ["thin", "extralight", "light", "regular", "medium", "semibold", "bold", "extrabold", "black"];
    const wd = (t: TypographyDefinition) => Math.abs(W.indexOf(styleWeight(t)) - W.indexOf(weight));
    const sized = ds.typography.filter((t) => Math.abs(t.fontSize - size) < 0.6);
    const sameScript = sized.filter((t) => isFaStyle(t) === fa);
    const pool = (sameScript.length ? sameScript : sized).filter((t) => wd(t) <= 1);
    const ranked = pool.map((t) => ({ t, s: wd(t) * 10 + (lh && typeof t.lineHeight === "number" ? Math.abs(t.lineHeight - lh) : 0) }))
      .sort((a, b) => a.s - b.s || a.t.name.length - b.t.name.length);
    return ranked[0]?.t;
  };
  const pickPaintStyle = (hex: string) => {
    const h = hex.toLowerCase().slice(0, 7);
    return ds.styles.filter((st) => st.type === "PAINT" && typeof st.value === "string" && String(st.value).toLowerCase().slice(0, 7) === h && String(st.value).length <= 7)
      .sort((a, b) => a.name.length - b.name.length)[0];
  };

  /** Sync: the set a drawn element should become, and the variant that looks most like it. */
  const pickByLook = (n: NodeSnapshot, kind: "button" | "badge") => {
    const want = kind === "button" ? /^button$/i : /^badge$/i;
    const sets = ds.componentSets.filter((st) => want.test(st.name.trim()) && !/^[_.]/.test(st.name));
    if (!sets.length) return undefined;
    const set = [...sets].sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0))[0];
    const variants = ds.components.filter((c) => c.componentSetId === set.id);
    const fill = n.fills?.find((f) => f.startsWith("#")), stroke = n.strokes?.find((f) => f.startsWith("#"));
    const textColor = texts(n)[0]?.fills?.find((f) => f.startsWith("#"));
    const hasIcon = (n.children ?? []).some((c) => c.type === "VECTOR" || c.type === "INSTANCE" || (c.type === "FRAME" && !c.children?.some((k) => k.type === "TEXT") && (c.w ?? 99) <= 24));
    // Resting state: Default / False where a property offers it, unless the element shows the thing (an icon).
    const resting = (c: typeof variants[number]) => Object.entries(c.variants ?? {}).every(([k, v]) => {
      const opts = set.properties.find((p) => p.name === k)?.options ?? [];
      if (/^icon$/i.test(k)) return hasIcon ? true : opts.includes("Default") ? v === "Default" : opts.includes("False") ? v === "False" : true;
      if (opts.includes("Default") && /state|type|theme|style/i.test(k) && !/^type$/i.test(k)) return v === "Default";
      if (opts.includes("False") && /destructive|disabled|loading|selected|current/i.test(k)) return v === "False";
      return true;
    });
    const pool = variants.filter(resting);
    const scored = (pool.length ? pool : variants).map((c) => ({ c,
      // Colour decides the kind (primary / success / gray…), height the size: text colour tells pale variants apart.
      s: Math.abs((c.dimensions?.height ?? 0) - (n.h ?? 0)) * 1.5 + colorDist(c.look?.fill, fill) / 3 + colorDist(c.look?.text, textColor) / 3 + (!!c.look?.stroke !== !!stroke ? 20 : colorDist(c.look?.stroke, stroke) / 8) }));
    scored.sort((a, b) => a.s - b.s);
    return scored[0] && { def: scored[0].c, set, score: scored[0].s };
  };

  const tryReplace = (n: NodeSnapshot, role: string, label?: string): boolean => {
    if (sync && (role.endsWith("action") || role === "badge")) {
      const pick = pickByLook(n, role === "badge" ? "badge" : "button");
      if (pick && pick.score < 60) {
        const { properties, textOverrides } = r.mapProps(pick.def, pick.set, label ? { label } : undefined, n.name, warnings);
        const componentName = `${pick.set.name} / ${Object.values(pick.def.variants ?? {}).join(", ")}`;
        out.push({ id: id(), op: "replace_with_instance", nodeId: n.id, nodeName: n.name, componentId: pick.def.id, componentKey: pick.def.remote ? pick.def.key : undefined, remote: pick.def.remote, componentName, properties, textOverrides, reason: `${role === "badge" ? "pill" : "button"} "${label ?? n.name}" → ${componentName} (closest by size and colour)` });
        return true;
      }
      if (pick) { unresolved.push({ type: "COMPONENT_NOT_FOUND", nodeId: n.id, component: pick.set.name, message: `"${label ?? n.name}" looks like a ${role} but no ${pick.set.name} variant looks close enough; left as is.` }); return false; }
    }
    const m = r.findComponent({ role }, n.name);
    if ("error" in m) { unresolved.push({ ...m.error, nodeId: n.id, message: `"${n.name}" looks like a ${role} but ${m.error.message}` }); return false; }
    const doubt = mappingDoubt(m, { role, label, box: n.w && n.h ? { w: n.w, h: n.h } : undefined });
    if (doubt) { unresolved.push({ type: "COMPONENT_NOT_FOUND", nodeId: n.id, component: m.set?.name ?? m.def.name, message: `"${n.name}" looks like a ${role}; "${m.set?.name ?? m.def.name}" is not a confident match (${doubt}).` }); return false; }
    const props = label ? { label } : undefined;
    const { properties, textOverrides } = r.mapProps(m.def, m.set, props, n.name, warnings);
    const componentName = m.set ? `${m.set.name} / ${Object.values(m.def.variants ?? {}).join(", ")}` : m.def.name;
    out.push({ id: id(), op: "replace_with_instance", nodeId: n.id, nodeName: n.name, componentId: m.def.id, componentKey: m.def.remote ? m.def.key : undefined, remote: m.def.remote, componentName, properties, textOverrides, reason: `custom ${role} → ${componentName}${label ? ` (label "${label}")` : ""}` });
    return true;
  };

  // Instances are left alone entirely. Components are the source: their layers get tokens, but never nested replacements.
  const visit = (n: NodeSnapshot, insideInstance: boolean, insideComponent = false) => {
    if (n.visible === false) return;
    if (n.type === "INSTANCE") insideInstance = true;
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") insideComponent = true;
    const nm = norm(n.name);
    if (!insideInstance && !insideComponent && (n.type === "FRAME" || n.type === "GROUP")) {
      const t = texts(n);
      const hasFill = (n.fills ?? []).length > 0;
      const filledDark = (n.fills ?? []).some((f) => f.startsWith("#") && !isLight(f));
      const hasStroke = (n.strokes ?? []).length > 0;
      const h = n.h ?? 0, w = n.w ?? 0;
      const inputish = INPUT_NAME.test(nm) || (hasStroke && !filledDark && h >= 36 && h <= 64 && w >= 160 && t.length >= 1 && t.length <= 2);
      // A round marker (a numbered step, an avatar initial) is neither a button nor a badge.
      const round = h > 0 && w < h * 1.3 && (n.radius ?? 0) >= h / 2 - 1;
      const buttonish = BUTTON_NAME.test(nm) || (!round && (hasFill || hasStroke) && h >= 28 && h <= 64 && w <= 420 && t.length === 1 && (n.children?.length ?? 0) <= 3);
      // Sync: a small pill with one line of text is a badge (status, tag).
      // (Wider than tall: a round step marker with a number isn't a badge.)
      const pill = sync && hasFill && h > 0 && h <= 32 && w >= h * 1.3 && (n.radius ?? 0) >= h / 2 - 1 && t.length === 1 && (n.children?.length ?? 0) <= 3;
      if (pill) { if (tryReplace(n, "badge", t[0]?.text?.chars)) return; }
      else if (INPUT_NAME.test(nm) || (inputish && !BUTTON_NAME.test(nm))) {
        const role = /password|رمز/.test(nm) ? "password-input" : "text-input";
        if (tryReplace(n, role, t[t.length - 1]?.text?.chars)) return;
      } else if (buttonish) {
        const role = filledDark ? "primary-action" : "secondary-action";
        if (tryReplace(n, role, t[0]?.text?.chars)) return;
      }
    }
    if (!insideInstance) {
      // Text styles
      if (n.type === "TEXT" && !n.text?.styleId) {
        const st = pickTextStyle(n) ?? (sync ? looseTextStyle(n) : undefined);
        if (st) out.push({ id: id(), op: "apply_text_style", nodeId: n.id, nodeName: n.name, styleId: st.styleId, styleKey: ds.styles.find((s) => s.id === st.styleId)?.remote ? ds.styles.find((s) => s.id === st.styleId)?.key : undefined, styleName: st.name, reason: `raw ${n.text?.font ?? ""} ${n.text?.fontSize}px → ${st.name}` });
      }
      // Fills → color variables
      if ((n.type === "FRAME" || n.type === "RECTANGLE" || n.type === "TEXT") && n.fills?.length === 1 && !n.bound?.fills && !n.fillStyle && n.fills[0].startsWith("#")) {
        const v = pickColor(n.fills[0]);
        if (v) out.push({ id: id(), op: "bind_fill", nodeId: n.id, nodeName: n.name, from: n.fills[0], variableId: v.id, variableKey: v.remote ? v.key : undefined, variableName: v.name, reason: `${n.fills[0]} → ${v.name}` });
        else {
          const ps = pickPaintStyle(n.fills[0]);
          if (ps) out.push({ id: id(), op: "apply_fill_style", nodeId: n.id, nodeName: n.name, from: n.fills[0], styleId: ps.id, styleKey: ps.remote ? ps.key : undefined, styleName: ps.name, reason: `${n.fills[0]} → ${ps.name} (colour style)` });
        }
      }
      // Spacing / radius → variables (auto-layout frames only)
      if (n.type === "FRAME" && n.layout && n.layout.mode !== "NONE") {
        const fields: [Extract<Transformation, { op: "bind_number" }>["field"], number | undefined][] = [
          ["itemSpacing", n.layout.gap], ["paddingTop", n.layout.padding?.top], ["paddingRight", n.layout.padding?.right], ["paddingBottom", n.layout.padding?.bottom], ["paddingLeft", n.layout.padding?.left],
        ];
        for (const [field, value] of fields) {
          if (!value || n.bound?.[field]) continue;
          const v = pickNum(spacingVars, value);
          if (v) out.push({ id: id(), op: "bind_number", nodeId: n.id, nodeName: n.name, field, from: value, variableId: v.id, variableKey: v.remote ? v.key : undefined, variableName: v.name, reason: `${field} ${value} → ${v.name}` });
        }
      }
      if (n.type === "FRAME" && n.radius && !n.bound?.topLeftRadius) {
        const v = pickNum(radiusVars, n.radius);
        if (v) out.push({ id: id(), op: "bind_number", nodeId: n.id, nodeName: n.name, field: "cornerRadius", from: n.radius, variableId: v.id, variableKey: v.remote ? v.key : undefined, variableName: v.name, reason: `radius ${n.radius} → ${v.name}` });
      }
      // Manual layout → Auto Layout
      if (!sync && n.type === "FRAME" && n.layout?.mode === "NONE" && (n.children?.length ?? 0) >= 2) {
        const conv = inferAutoLayout(n);
        if (conv) out.push({ id: id(), op: "convert_auto_layout", nodeId: n.id, nodeName: n.name, ...conv, reason: `manual layout → ${conv.direction.toLowerCase()} Auto Layout (gap ${conv.gap})` });
      }
    }
    for (const c of n.children ?? []) visit(c, insideInstance, insideComponent);
  };
  visit(root, false);

  const keyOf = (t: Transformation) => t.op === "replace_with_instance" ? `custom element → ${t.componentName}` : t.op === "bind_number" ? `${t.field === "cornerRadius" ? "radius" : "spacing"} value → ${t.field === "cornerRadius" ? "radius" : "spacing"} token` : t.op === "bind_fill" ? "raw color → color token" : t.op === "apply_fill_style" ? "raw color → color style" : t.op === "apply_text_style" ? `raw text → ${t.styleName}` : "manual layout → Auto Layout";
  // Human summary, grouped.
  const groups = new Map<string, number>();
  for (const t of out) {
    const key = keyOf(t);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const summary = [...groups].map(([k, n]) => `${n} × ${k}`);

  const grouped = [...groups.keys()].map((label, i) => { const ids = out.filter((t) => keyOf(t) === label).map((t) => t.id); return { id: `g${i + 1}`, label, count: ids.length, ids }; });
  return { analysisId: `an_${hash(JSON.stringify(out) + root.id)}`, transformations: out, summary, groups: grouped, unresolved };
}

function inferAutoLayout(n: NodeSnapshot): { direction: "HORIZONTAL" | "VERTICAL"; gap: number; padding: { top: number; right: number; bottom: number; left: number } } | undefined {
  const kids = (n.children ?? []).filter((c) => c.visible !== false && c.x !== undefined && c.w !== undefined);
  if (kids.length < 2) return undefined;
  const tryAxis = (dir: "VERTICAL" | "HORIZONTAL") => {
    const pos = dir === "VERTICAL" ? (c: NodeSnapshot) => c.y! : (c: NodeSnapshot) => c.x!;
    const len = dir === "VERTICAL" ? (c: NodeSnapshot) => c.h! : (c: NodeSnapshot) => c.w!;
    const s = [...kids].sort((a, b) => pos(a) - pos(b));
    const gaps: number[] = [];
    for (let i = 1; i < s.length; i++) { const g = pos(s[i]) - (pos(s[i - 1]) + len(s[i - 1])); if (g < -0.5) return undefined; gaps.push(g); }
    gaps.sort((a, b) => a - b);
    const gap = Math.round(gaps[Math.floor(gaps.length / 2)]);
    const minX = Math.min(...kids.map((c) => c.x!)), minY = Math.min(...kids.map((c) => c.y!));
    const maxX = Math.max(...kids.map((c) => c.x! + c.w!)), maxY = Math.max(...kids.map((c) => c.y! + c.h!));
    return { direction: dir, gap, padding: { top: Math.round(minY), left: Math.round(minX), right: Math.max(0, Math.round((n.w ?? maxX) - maxX)), bottom: Math.max(0, Math.round((n.h ?? maxY) - maxY)) } };
  };
  return tryAxis("VERTICAL") ?? tryAxis("HORIZONTAL");
}

// ---------------- Verification ----------------

export interface Mismatch { path: string; nodeId?: string; issue: string; expected?: unknown; actual?: unknown }
export interface VerifyOptions {
  /** Rendered source size per plan path (HTML imports): frames far from it are reported. */
  sources?: Record<string, { w: number; h?: number }>;
  /** Plan path → created node id (from the execution report), to check interaction destinations. */
  nodeIds?: Record<string, string>;
}

/** Sizes are "far off" beyond 4px or 5%, whichever is larger (font metrics shift text a little). */
const far = (a: number, b: number) => Math.abs(a - b) > Math.max(4, Math.abs(b) * 0.05);

/** All text layers inside a snapshot (for checking an instance's text overrides). */
const textsIn = (n: NodeSnapshot): NodeSnapshot[] => (n.type === "TEXT" ? [n] : (n.children ?? []).flatMap(textsIn));

const KIND_TYPE: Record<ResolvedNode["kind"], string> = { frame: "FRAME", text: "TEXT", instance: "INSTANCE", rect: "RECTANGLE", svg: "FRAME" };

/** Structural comparison of an executed plan against the inspected Figma result. */
export function verifyAgainstPlan(expected: ResolvedNode, actual: NodeSnapshot | undefined, opts: VerifyOptions = {}): Mismatch[] {
  const out: Mismatch[] = [];
  const walk = (e: ResolvedNode, a: NodeSnapshot | undefined) => {
    if (!a) { out.push({ path: e.path, issue: "missing node", expected: `${KIND_TYPE[e.kind]} "${e.name}"` }); return; }
    const section = e.kind === "frame" && e.role === "section" && a.type === "SECTION";
    if (a.type !== KIND_TYPE[e.kind] && !section) out.push({ path: e.path, nodeId: a.id, issue: "wrong node type", expected: KIND_TYPE[e.kind], actual: a.type });
    if (a.name !== e.name) out.push({ path: e.path, nodeId: a.id, issue: "name differs", expected: e.name, actual: a.name });
    if (e.kind === "instance" && a.instance?.componentId && a.instance.componentId !== e.componentId) out.push({ path: e.path, nodeId: a.id, issue: "wrong component/variant", expected: e.componentName, actual: a.instance.component });
    if (e.kind === "text" && a.text && a.text.chars !== e.content) out.push({ path: e.path, nodeId: a.id, issue: "text content differs", expected: e.content, actual: a.text.chars });
    if (e.kind === "text" && e.textStyleId && a.text?.styleId !== e.textStyleId) out.push({ path: e.path, nodeId: a.id, issue: "text style not applied", expected: e.textStyleId, actual: a.text?.styleId });
    if (e.kind === "instance") {
      for (const [k, v] of Object.entries(e.properties)) {
        const got = a.instance?.props?.[k];
        if (got !== undefined && got !== v) out.push({ path: e.path, nodeId: a.id, issue: `property "${k.split("#")[0]}" differs`, expected: v, actual: got });
      }
      // Needs an expanded snapshot (expandInstances): text overrides landed, and nothing was hidden behind our back.
      if (a.children) {
        const texts = textsIn(a);
        for (const [layer, v] of Object.entries(e.textOverrides)) {
          const t = texts.find((x) => x.name === layer);
          if (t && t.text?.chars !== v) out.push({ path: e.path, nodeId: t.id, issue: `text "${layer}" not overridden`, expected: v, actual: t.text?.chars });
        }
      }
      const hidden = Object.entries(a.instance?.overrides ?? {}).filter(([, f]) => f.includes("visible")).map(([n]) => n);
      if (hidden.length) out.push({ path: e.path, nodeId: a.id, issue: "layers hidden by an override the plan didn't ask for", actual: hidden });
    }
    // Prototype: every interaction exists and points at the node the plan meant.
    if (e.interactions?.length) {
      const got = a.reactions ?? [];
      for (const it of e.interactions) {
        const want = it.to ? ("path" in it.to ? opts.nodeIds?.[it.to.path] : it.to.nodeId) : undefined;
        const hit = got.find((r) => r.action === it.action && (r.trigger === it.trigger) && (!want || r.to === want));
        if (!hit) out.push({ path: e.path, nodeId: a.id, issue: "interaction missing", expected: `${it.trigger} → ${it.action}${want ? ` → ${want}` : ""}`, actual: got.map((r) => `${r.trigger} → ${r.action}${r.to ? ` → ${r.to}` : ""}`) });
      }
    }
    // Size: fixed sizes from the plan, and the rendered box of the source (HTML import). Text is left out: its
    // width depends on font metrics, and its container is checked instead.
    if (e.kind !== "text" && a.w !== undefined && a.h !== undefined) {
      if (e.width && e.sizingH !== "fill" && e.sizingH !== "hug" && far(a.w, e.width)) out.push({ path: e.path, nodeId: a.id, issue: "width differs from the plan", expected: e.width, actual: a.w });
      if (e.height && e.sizingV !== "fill" && e.sizingV !== "hug" && far(a.h, e.height)) out.push({ path: e.path, nodeId: a.id, issue: "height differs from the plan", expected: e.height, actual: a.h });
      const src = opts.sources?.[e.path];
      // A DS instance may differ a little from the element it replaced; half again or more means a wrong match.
      const off = e.kind === "instance" ? (x: number, y: number) => Math.abs(x - y) > Math.max(8, y * 0.5) : far;
      // Instance heights are left out: DS inputs often include their label, so they're taller than the bare <input>.
      if (src && (off(a.w, src.w) || (src.h !== undefined && e.kind !== "instance" && off(a.h, src.h)))) out.push({ path: e.path, nodeId: a.id, issue: e.kind === "instance" ? "instance size far from the element it replaced" : "size far from the source's rendered box", expected: `${src.w}×${src.h ?? "any"}`, actual: `${a.w}×${a.h}` });
    }
    if (e.kind === "frame") {
      if (!section && e.layout && e.layout.direction !== (a.layout?.mode ?? "NONE")) out.push({ path: e.path, nodeId: a.id, issue: "layout direction differs", expected: e.layout.direction, actual: a.layout?.mode });
      if (!section && e.layout?.gap?.value !== undefined && a.layout?.gap !== undefined && Math.abs(e.layout.gap.value - a.layout.gap) > 0.5) out.push({ path: e.path, nodeId: a.id, issue: "gap differs", expected: e.layout.gap.value, actual: a.layout.gap });
      if (e.layout?.gap?.variableId && !a.bound?.itemSpacing) out.push({ path: e.path, nodeId: a.id, issue: "gap not bound to token", expected: e.layout.gap.variableId });
      const kids = a.children ?? [];
      if (a.truncated) out.push({ path: e.path, nodeId: a.id, issue: "snapshot truncated; deeper checks skipped" });
      if (kids.length !== e.children.length && !a.truncated) out.push({ path: e.path, nodeId: a.id, issue: "child count differs", expected: e.children.length, actual: kids.length });
      e.children.forEach((c, i) => walk(c, kids[i]));
    }
  };
  walk(expected, actual);
  return out;
}
