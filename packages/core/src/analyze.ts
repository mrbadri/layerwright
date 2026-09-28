// Mode B: compare an existing design (compact snapshot) against the Design System and
// propose non-destructive transformations. Pure & deterministic; nothing is applied here.
import type { DesignSystem, NodeSnapshot, Transformation, TypographyDefinition, VariableDefinition, ResolvedNode, StructuredError } from "./types.ts";
import { Resolver, hash } from "./resolver.ts";
import { norm } from "./semantics.ts";

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
  unresolved: StructuredError[];
}

export function analyzeDesign(ds: DesignSystem, root: NodeSnapshot): AnalysisResult {
  const r = new Resolver(ds);
  const out: Transformation[] = [];
  const unresolved: StructuredError[] = [];
  let seq = 0;
  const id = () => `t${++seq}`;
  const warnings: string[] = [];

  const floatVars = ds.variables.filter((v) => v.type === "FLOAT" && typeof v.value === "number");
  const spacingVars = floatVars.filter((v) => /space|spacing|gap|padding|inset|stack|gutter/i.test(`${v.collection} ${v.name}`) || v.scopes?.includes("GAP"));
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

  const tryReplace = (n: NodeSnapshot, role: string, label?: string): boolean => {
    const m = r.findComponent({ role }, n.name);
    if ("error" in m) { unresolved.push({ ...m.error, nodeId: n.id, message: `"${n.name}" looks like a ${role} but ${m.error.message}` }); return false; }
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
      const buttonish = BUTTON_NAME.test(nm) || ((hasFill || hasStroke) && h >= 28 && h <= 64 && w <= 420 && t.length === 1 && (n.children?.length ?? 0) <= 3);
      if (INPUT_NAME.test(nm) || (inputish && !BUTTON_NAME.test(nm))) {
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
        const st = pickTextStyle(n);
        if (st) out.push({ id: id(), op: "apply_text_style", nodeId: n.id, nodeName: n.name, styleId: st.styleId, styleKey: ds.styles.find((s) => s.id === st.styleId)?.remote ? ds.styles.find((s) => s.id === st.styleId)?.key : undefined, styleName: st.name, reason: `raw ${n.text?.font ?? ""} ${n.text?.fontSize}px → ${st.name}` });
      }
      // Fills → color variables
      if ((n.type === "FRAME" || n.type === "RECTANGLE" || n.type === "TEXT") && n.fills?.length === 1 && !n.bound?.fills && !n.fillStyle && n.fills[0].startsWith("#")) {
        const v = pickColor(n.fills[0]);
        if (v) out.push({ id: id(), op: "bind_fill", nodeId: n.id, nodeName: n.name, from: n.fills[0], variableId: v.id, variableKey: v.remote ? v.key : undefined, variableName: v.name, reason: `${n.fills[0]} → ${v.name}` });
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
      if (n.type === "FRAME" && n.layout?.mode === "NONE" && (n.children?.length ?? 0) >= 2) {
        const conv = inferAutoLayout(n);
        if (conv) out.push({ id: id(), op: "convert_auto_layout", nodeId: n.id, nodeName: n.name, ...conv, reason: `manual layout → ${conv.direction.toLowerCase()} Auto Layout (gap ${conv.gap})` });
      }
    }
    for (const c of n.children ?? []) visit(c, insideInstance, insideComponent);
  };
  visit(root, false);

  // Human summary, grouped.
  const groups = new Map<string, number>();
  for (const t of out) {
    const key = t.op === "replace_with_instance" ? `custom element → ${t.componentName}` : t.op === "bind_number" ? `${t.field === "cornerRadius" ? "radius" : "spacing"} value → ${t.field === "cornerRadius" ? "radius" : "spacing"} token` : t.op === "bind_fill" ? "raw color → color token" : t.op === "apply_text_style" ? `raw text → ${t.styleName}` : "manual layout → Auto Layout";
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const summary = [...groups].map(([k, n]) => `${n} × ${k}`);
  return { analysisId: `an_${hash(JSON.stringify(out) + root.id)}`, transformations: out, summary, unresolved };
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

const KIND_TYPE: Record<ResolvedNode["kind"], string> = { frame: "FRAME", text: "TEXT", instance: "INSTANCE", rect: "RECTANGLE" };

/** Structural comparison of an executed plan against the inspected Figma result. */
export function verifyAgainstPlan(expected: ResolvedNode, actual: NodeSnapshot | undefined): Mismatch[] {
  const out: Mismatch[] = [];
  const walk = (e: ResolvedNode, a: NodeSnapshot | undefined) => {
    if (!a) { out.push({ path: e.path, issue: "missing node", expected: `${KIND_TYPE[e.kind]} "${e.name}"` }); return; }
    if (a.type !== KIND_TYPE[e.kind]) out.push({ path: e.path, nodeId: a.id, issue: "wrong node type", expected: KIND_TYPE[e.kind], actual: a.type });
    if (a.name !== e.name) out.push({ path: e.path, nodeId: a.id, issue: "name differs", expected: e.name, actual: a.name });
    if (e.kind === "instance" && a.instance?.componentId && a.instance.componentId !== e.componentId) out.push({ path: e.path, nodeId: a.id, issue: "wrong component/variant", expected: e.componentName, actual: a.instance.component });
    if (e.kind === "text" && a.text && a.text.chars !== e.content) out.push({ path: e.path, nodeId: a.id, issue: "text content differs", expected: e.content, actual: a.text.chars });
    if (e.kind === "text" && e.textStyleId && a.text?.styleId !== e.textStyleId) out.push({ path: e.path, nodeId: a.id, issue: "text style not applied", expected: e.textStyleId, actual: a.text?.styleId });
    if (e.kind === "instance") {
      for (const [k, v] of Object.entries(e.properties)) {
        const got = a.instance?.props?.[k];
        if (got !== undefined && got !== v) out.push({ path: e.path, nodeId: a.id, issue: `property "${k.split("#")[0]}" differs`, expected: v, actual: got });
      }
    }
    if (e.kind === "frame") {
      if (e.layout && e.layout.direction !== (a.layout?.mode ?? "NONE")) out.push({ path: e.path, nodeId: a.id, issue: "layout direction differs", expected: e.layout.direction, actual: a.layout?.mode });
      if (e.layout?.gap?.value !== undefined && a.layout?.gap !== undefined && Math.abs(e.layout.gap.value - a.layout.gap) > 0.5) out.push({ path: e.path, nodeId: a.id, issue: "gap differs", expected: e.layout.gap.value, actual: a.layout.gap });
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
