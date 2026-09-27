// Resolver: maps semantic requirements (component names, roles, variants, tokens) to real
// Design System entities, and compiles a validated DesignPlan into an executable ResolvedPlan.
import type { ComponentDefinition, ComponentSetDefinition, DesignSystem, Num, Paint, ResolvedFrame, ResolvedInstance, ResolvedNode, ResolvedPlan, Sizing, StructuredError, TypographyDefinition, VariableDefinition } from "./types.ts";
import type { DesignPlan } from "./dsl.ts";
import { norm } from "./semantics.ts";

export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const ROLE_BASE: Record<string, string> = {
  "primary-action": "button", "secondary-action": "button", "destructive-action": "button", action: "button",
  input: "text-input", "password-input": "text-input", textfield: "text-input", "error-dialog": "dialog", modal: "dialog",
};
const ROLE_EMPHASIS: Record<string, string> = { "primary-action": "primary", "secondary-action": "secondary", "destructive-action": "destructive", "password-input": "password" };

type Match = { def: ComponentDefinition; set?: ComponentSetDefinition };
type Fail = { error: StructuredError };

export class Resolver {
  private setById: Map<string, ComponentSetDefinition>;
  constructor(public ds: DesignSystem) {
    this.setById = new Map(ds.componentSets.map((s) => [s.id, s]));
  }

  private variantsOf(set: ComponentSetDefinition) {
    return this.ds.components.filter((c) => c.componentSetId === set.id);
  }

  /** Find a component (and variant) by name and/or semantic role. */
  findComponent(req: { component?: string; role?: string; variant?: string | Record<string, string> }, path = ""): Match | Fail {
    const standalone = this.ds.components.filter((c) => !c.componentSetId);
    type Cand = { kind: "set"; v: ComponentSetDefinition } | { kind: "comp"; v: ComponentDefinition };
    const cands: Cand[] = [...this.ds.componentSets.map((v) => ({ kind: "set" as const, v })), ...standalone.map((v) => ({ kind: "comp" as const, v }))];
    let best: { c: Cand; score: number } | undefined;
    const want = req.component ? norm(req.component) : undefined;
    const wantLast = req.component ? norm(req.component.split("/").pop()!) : undefined;
    const role = req.role;
    const baseRole = role ? ROLE_BASE[role] ?? role : undefined;
    for (const c of cands) {
      const n = norm(c.v.name);
      const last = norm(c.v.name.split("/").pop()!);
      const hints = c.v.semanticHints ?? [];
      let score = 0;
      if (want) {
        if (n === want) score += 100;
        else if (last === wantLast) score += 80;
        else if (n.includes(want) || want.includes(last)) score += 30;
        else continue;
      }
      if (role) {
        if (hints.includes(role)) score += 20;
        else if (baseRole && hints.includes(baseRole)) score += 12;
        else if (hints.includes(`${baseRole}?`)) score += 4;
        else if (!want) continue;
      }
      if (!want && !role) continue;
      if (c.v.remote) score += 1;
      if (c.kind === "set") score += 2; // prefer sets (they carry variants)
      score -= n.split(" ").length * 0.1; // prefer shorter, canonical names
      if (!best || score > best.score) best = { c, score };
    }
    if (!best) {
      return { error: { type: "COMPONENT_NOT_FOUND", path, component: req.component ?? req.role, message: `No component matches ${req.component ? `name "${req.component}"` : ""}${req.component && role ? " / " : ""}${role ? `role "${role}"` : ""}.`, suggestions: this.suggest(req.component ?? role ?? "") } };
    }
    if (best.c.kind === "comp") {
      if (req.variant) return { def: best.c.v }; // standalone component: variant ignored but not fatal
      return { def: best.c.v };
    }
    const set = best.c.v;
    const variants = this.variantsOf(set);
    if (variants.length === 0) return { error: { type: "COMPONENT_NOT_FOUND", path, component: set.name, message: `Component set "${set.name}" has no variants available.` } };
    const def = variants.find((v) => v.id === set.defaultVariantId) ?? variants[0];
    const pick = this.pickVariant(set, variants, def, req.variant, role, path);
    if ("error" in pick) return pick;
    return { def: pick.def, set };
  }

  private pickVariant(set: ComponentSetDefinition, variants: ComponentDefinition[], def: ComponentDefinition, variant: string | Record<string, string> | undefined, role: string | undefined, path: string): { def: ComponentDefinition } | Fail {
    const defVals = def.variants ?? {};
    const closeness = (v: ComponentDefinition) => Object.entries(v.variants ?? {}).filter(([k, x]) => defVals[k] === x).length;
    const options = () => set.properties.filter((p) => p.type === "VARIANT").map((p) => `${p.name}: ${(p.options ?? []).join(" | ")}`);
    if (typeof variant === "string") {
      const parts = variant.split(/[,/]/).map((s) => norm(s)).filter(Boolean);
      const matches = variants.filter((v) => { const vals = Object.values(v.variants ?? {}).map(norm); return parts.every((p) => vals.includes(p) || vals.some((x) => x.includes(p))); });
      if (!matches.length) return { error: { type: "INVALID_VARIANT", path, component: set.name, message: `Variant "${variant}" not found on "${set.name}".`, suggestions: options() } };
      matches.sort((a, b) => closeness(b) - closeness(a));
      return { def: matches[0] };
    }
    if (variant && typeof variant === "object") {
      const entries = Object.entries(variant).map(([k, v]) => [norm(k), norm(v)] as const);
      const matches = variants.filter((c) => { const vv = Object.fromEntries(Object.entries(c.variants ?? {}).map(([k, v]) => [norm(k), norm(v)])); return entries.every(([k, v]) => vv[k] === v); });
      if (!matches.length) return { error: { type: "INVALID_VARIANT", path, component: set.name, message: `Variant ${JSON.stringify(variant)} not found on "${set.name}".`, suggestions: options() } };
      matches.sort((a, b) => closeness(b) - closeness(a));
      return { def: matches[0] };
    }
    if (role) {
      const byRole = variants.filter((v) => v.semanticHints?.includes(role));
      if (byRole.length) { byRole.sort((a, b) => closeness(b) - closeness(a)); return { def: byRole[0] }; }
      const emph = ROLE_EMPHASIS[role];
      if (emph) {
        const e = variants.filter((v) => Object.values(v.variants ?? {}).some((x) => norm(x).includes(emph)));
        if (e.length) { e.sort((a, b) => closeness(b) - closeness(a)); return { def: e[0] }; }
      }
    }
    return { def };
  }

  suggest(q: string): string[] {
    const t = norm(q).split(" ").filter((x) => x.length > 2);
    const names = [...this.ds.componentSets.map((s) => s.name), ...this.ds.components.filter((c) => !c.componentSetId).map((c) => c.name)];
    const scored = names.map((n) => ({ n, s: t.filter((x) => norm(n).includes(x)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    return (scored.length ? scored.map((x) => x.n) : names).slice(0, 5);
  }

  findVariable(ref: string, type: VariableDefinition["type"]): VariableDefinition | undefined {
    const r = norm(ref.replace(/^[${]+|}$/g, ""));
    const pool = this.ds.variables.filter((v) => v.type === type);
    return (
      pool.find((v) => norm(v.name) === r) ??
      pool.find((v) => norm(`${v.collection} ${v.name}`) === r) ??
      pool.filter((v) => norm(v.name).endsWith(` ${r}`) || norm(v.name).endsWith(r)).sort((a, b) => a.name.length - b.name.length)[0]
    );
  }

  resolveNum(v: number | string | undefined, path: string, errors: StructuredError[], category = "spacing"): Num | undefined {
    if (v === undefined) return undefined;
    if (typeof v === "number") return { value: v };
    const asNum = Number(v);
    if (!Number.isNaN(asNum)) return { value: asNum };
    const found = this.findVariable(v, "FLOAT");
    if (!found) {
      errors.push({ type: "TOKEN_NOT_FOUND", path, message: `No ${category} variable matches "${v}".`, suggestions: this.ds.variables.filter((x) => x.type === "FLOAT").map((x) => x.name).filter((n) => norm(n).includes(norm(category).split(" ")[0])).slice(0, 8) });
      return undefined;
    }
    return { variableId: found.id, variableKey: found.remote ? found.key : undefined, value: typeof found.value === "number" ? found.value : undefined };
  }

  resolvePaint(ref: string | undefined, path: string, errors: StructuredError[]): Paint | undefined {
    if (!ref) return undefined;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(ref)) return { hex: ref };
    const v = this.findVariable(ref, "COLOR");
    if (v) return { variableId: v.id, variableKey: v.remote ? v.key : undefined };
    const r = norm(ref);
    const style = this.ds.styles.find((s) => s.type === "PAINT" && (norm(s.name) === r || norm(s.name).endsWith(r)));
    if (style) return { styleId: style.id, styleKey: style.remote ? style.key : undefined };
    errors.push({ type: "TOKEN_NOT_FOUND", path, message: `No color variable or paint style matches "${ref}".`, suggestions: this.ds.variables.filter((x) => x.type === "COLOR").map((x) => x.name).filter((n) => r.split(" ").some((t) => t.length > 2 && norm(n).includes(t))).slice(0, 8) });
    return undefined;
  }

  findTextStyle(style: string | undefined, role: string | undefined): TypographyDefinition | undefined {
    const ty = this.ds.typography;
    if (style) {
      const r = norm(style);
      return ty.find((t) => norm(t.name) === r) ?? ty.filter((t) => norm(t.name).endsWith(r) || norm(t.name).includes(r)).sort((a, b) => a.name.length - b.name.length)[0];
    }
    if (!role) return undefined;
    const target: Record<string, number> = { display: 40, heading: 28, title: 22, subheading: 18, body: 16, label: 14, caption: 12, overline: 11, code: 14 };
    const r = role === "title" ? "heading" : role;
    const pool = ty.filter((t) => t.role === r);
    if (!pool.length) return undefined;
    const size = target[role] ?? 16;
    return [...pool].sort((a, b) => Math.abs(a.fontSize - size) - Math.abs(b.fontSize - size) || a.name.length - b.name.length)[0];
  }

  /** Map DSL props onto component property keys. Unknown props fall back to text-layer overrides. */
  mapProps(def: ComponentDefinition, set: ComponentSetDefinition | undefined, props: Record<string, string | number | boolean> | undefined, path: string, warnings: string[]) {
    const properties: Record<string, string | boolean> = {};
    const textOverrides: Record<string, string> = {};
    const defs = (set?.properties ?? def.properties ?? []).filter((p) => p.type !== "VARIANT");
    for (const [k, raw] of Object.entries(props ?? {})) {
      const nk = norm(k);
      let p = defs.find((d) => norm(d.name) === nk) ?? defs.find((d) => norm(d.name).startsWith(nk) || nk.startsWith(norm(d.name)));
      if (!p && ["label", "text", "content", "title", "value"].includes(nk)) {
        const texts = defs.filter((d) => d.type === "TEXT");
        if (texts.length === 1) p = texts[0];
      }
      if (p && p.type === "TEXT") { properties[p.key] = String(raw); continue; }
      if (p && p.type === "BOOLEAN") { properties[p.key] = raw === true || raw === "true"; continue; }
      if (p && p.type === "INSTANCE_SWAP") { warnings.push(`${path}: instance-swap property "${p.name}" is not supported yet; ignored.`); continue; }
      // Fallback: override a text layer by name.
      const layers = def.textLayers ?? [];
      const layer = layers.find((l) => norm(l) === nk) ?? (layers.length === 1 && typeof raw !== "boolean" ? layers[0] : undefined);
      if (layer && typeof raw !== "boolean") { textOverrides[layer] = String(raw); continue; }
      warnings.push(`${path}: "${def.componentSet ?? def.name}" has no property or text layer "${k}"; ignored. Available: ${defs.map((d) => d.name).join(", ") || "none"}.`);
    }
    return { properties, textOverrides };
  }
}

// ---------------- Plan compilation ----------------

const CONTAINERS = new Set(["screen", "frame", "section", "stack", "row", "card", "modal", "navigation", "list"]);
const PRESETS: Record<string, any> = {
  screen: { layout: { direction: "vertical", padding: 24, gap: 16 } },
  section: { layout: { direction: "vertical", gap: 12 } },
  stack: { layout: { direction: "vertical", gap: 8 } },
  row: { layout: { direction: "horizontal", gap: 8, crossAlign: "center" } },
  card: { layout: { direction: "vertical", padding: 16, gap: 12 }, radius: 12 },
  modal: { layout: { direction: "vertical", padding: 24, gap: 16 }, radius: 16 },
  navigation: { layout: { direction: "horizontal", padding: { x: 16, y: 12 }, gap: 8, align: "space-between", crossAlign: "center" } },
  list: { layout: { direction: "vertical", gap: 0 } },
  frame: {},
};
const ALIGN: Record<string, "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" | "BASELINE"> = { start: "MIN", center: "CENTER", end: "MAX", "space-between": "SPACE_BETWEEN", baseline: "BASELINE" };
const WEIGHT = { regular: "Regular", medium: "Medium", semibold: "Semi Bold", bold: "Bold" } as const;
const ROLE_FALLBACK: Record<string, { size: number; weight: "Regular" | "Medium" | "Semi Bold" | "Bold" }> = {
  display: { size: 40, weight: "Bold" }, heading: { size: 28, weight: "Bold" }, title: { size: 22, weight: "Semi Bold" }, subheading: { size: 18, weight: "Semi Bold" },
  body: { size: 16, weight: "Regular" }, label: { size: 14, weight: "Medium" }, caption: { size: 12, weight: "Regular" }, overline: { size: 11, weight: "Medium" }, code: { size: 14, weight: "Regular" },
};

export interface PlanSummary {
  screens: string[];
  instances: Record<string, number>;
  frames: number;
  texts: number;
  primitives: number;
  tokensUsed: string[];
  textStylesUsed: string[];
}

export interface CompileResult {
  ok: boolean;
  plan?: ResolvedPlan;
  errors: StructuredError[];
  warnings: string[];
  summary: PlanSummary;
}

function sizing(v: number | "hug" | "fill" | undefined): { size?: number; mode?: Sizing } {
  if (v === undefined) return {};
  if (typeof v === "number") return { size: v, mode: "fixed" };
  return { mode: v };
}

export function compilePlan(ds: DesignSystem, plan: DesignPlan): CompileResult {
  const r = new Resolver(ds);
  const errors: StructuredError[] = [];
  const warnings: string[] = [];
  const summary: PlanSummary = { screens: [], instances: {}, frames: 0, texts: 0, primitives: 0, tokensUsed: [], textStylesUsed: [] };
  const tokenSet = new Set<string>();
  const styleSet = new Set<string>();
  const varName = (id?: string) => ds.variables.find((v) => v.id === id)?.name;
  const noteNum = (n?: Num) => { const nm = varName(n?.variableId); if (nm) tokenSet.add(nm); return n; };
  const notePaint = (p?: Paint) => { const nm = varName(p?.variableId) ?? ds.styles.find((s) => s.id === p?.styleId)?.name; if (nm) tokenSet.add(nm); return p; };

  const instanceFrom = (node: any, path: string, role?: string, defaultName?: string): ResolvedInstance | Fail => {
    const m = r.findComponent({ component: node.component, role: node.role ?? role, variant: node.variant }, path);
    if ("error" in m) return m;
    const { properties, textOverrides } = r.mapProps(m.def, m.set, node.props, path, warnings);
    const label = m.set ? `${m.set.name} / ${Object.values(m.def.variants ?? {}).join(", ")}` : m.def.name;
    summary.instances[label] = (summary.instances[label] ?? 0) + 1;
    const w = sizing(node.width), h = sizing(node.height);
    return { kind: "instance", path, name: node.name ?? defaultName ?? m.set?.name ?? m.def.name, componentId: m.def.id, componentKey: m.def.remote ? m.def.key : undefined, remote: m.def.remote, componentName: label, properties, textOverrides, width: w.size, height: h.size, sizingH: w.mode, sizingV: h.mode };
  };

  const pad = (p: any, path: string) => {
    if (p === undefined) return undefined;
    const n = (v: any, sub: string) => noteNum(r.resolveNum(v, `${path}.${sub}`, errors));
    if (typeof p === "number" || typeof p === "string") { const v = n(p, "padding"); return { top: v, right: v, bottom: v, left: v }; }
    if ("x" in p || "y" in p) { const x = n(p.x, "padding.x"), y = n(p.y, "padding.y"); return { top: y, bottom: y, left: x, right: x }; }
    return { top: n(p.top, "padding.top"), right: n(p.right, "padding.right"), bottom: n(p.bottom, "padding.bottom"), left: n(p.left, "padding.left") };
  };

  const build = (node: any, path: string, parentDir: "HORIZONTAL" | "VERTICAL" | "NONE" | null): ResolvedNode | undefined => {
    const t = node.type as string;
    const stretch = parentDir === "VERTICAL" ? "fill" : undefined;
    const w = sizing(node.width), h = sizing(node.height);
    const defaultH = (x: Sizing | undefined) => w.mode ?? x;

    if (CONTAINERS.has(t)) {
      // A container can ask to *be* a component (e.g. card/modal/navigation from the DS).
      if (node.component || (node.role && t !== "screen")) {
        const inst = instanceFrom(node, path, node.role, node.name);
        if (!("error" in inst)) {
          if (node.children?.length) warnings.push(`${path}: children ignored because "${t}" resolved to component ${inst.componentName}.`);
          inst.sizingH ??= stretch;
          return inst;
        }
        if (!node.allowFallback) { errors.push(inst.error); return undefined; }
        warnings.push(`${path}: ${inst.error.message} Falling back to a plain ${t} frame (allowFallback).`);
      }
      const preset = PRESETS[t] ?? {};
      const layoutIn = { ...(preset.layout ?? {}), ...(node.layout ?? {}) };
      const dir = layoutIn.direction === "horizontal" ? "HORIZONTAL" : layoutIn.direction === "none" ? "NONE" : "VERTICAL";
      summary.frames++;
      let fill = notePaint(r.resolvePaint(node.fill, `${path}.fill`, errors));
      if (!fill && (t === "screen" || t === "card" || t === "modal")) fill = { hex: "#FFFFFF" };
      const frame: ResolvedFrame = {
        kind: "frame", path, role: t, name: node.name ?? t[0].toUpperCase() + t.slice(1),
        layout: dir === "NONE" ? { direction: "NONE" } : {
          direction: dir,
          gap: noteNum(r.resolveNum(layoutIn.gap, `${path}.layout.gap`, errors)),
          padding: pad(layoutIn.padding, `${path}.layout`),
          primaryAlign: layoutIn.align ? (ALIGN[layoutIn.align] as any) : undefined,
          counterAlign: layoutIn.crossAlign ? (ALIGN[layoutIn.crossAlign] as any) : undefined,
          wrap: layoutIn.wrap,
        },
        fill,
        stroke: notePaint(r.resolvePaint(node.stroke, `${path}.stroke`, errors)),
        strokeWeight: node.strokeWeight,
        radius: noteNum(r.resolveNum(node.radius ?? preset.radius, `${path}.radius`, errors, "radius")),
        clip: node.clip,
        width: w.size ?? (t === "screen" ? 390 : undefined),
        height: h.size,
        sizingH: t === "screen" ? w.mode ?? "fixed" : defaultH(stretch ?? (parentDir === null ? "hug" : undefined)),
        sizingV: h.mode ?? "hug",
        children: [],
      };
      if (node.effect) {
        const e = ds.styles.find((s) => s.type === "EFFECT" && norm(s.name).includes(norm(node.effect)));
        if (e) frame.effectStyleId = e.id; else errors.push({ type: "STYLE_NOT_FOUND", path: `${path}.effect`, message: `No effect style matches "${node.effect}".`, suggestions: ds.styles.filter((s) => s.type === "EFFECT").map((s) => s.name).slice(0, 8) });
      }
      (node.children ?? []).forEach((c: any, i: number) => { const b = build(c, `${path}.children[${i}]`, dir); if (b) frame.children.push(b); });
      return frame;
    }

    if (t === "link" && !node.component && !node.role) {
      const m = r.findComponent({ role: "link" }, path);
      if (!("error" in m)) return build({ ...node, role: "link" }, path, parentDir);
    }
    if (t === "text" || (t === "link" && !node.component && !node.role)) {
      summary.texts++;
      const role = t === "link" ? "body" : node.role ?? "body";
      const st = r.findTextStyle(node.style, role);
      if (node.style && !st) errors.push({ type: "STYLE_NOT_FOUND", path: `${path}.style`, message: `No text style matches "${node.style}".`, suggestions: ds.typography.map((x) => x.name).slice(0, 10) });
      if (st) styleSet.add(st.name);
      else if (!node.style && ds.typography.length) warnings.push(`${path}: no text style for role "${role}"; using raw font size.`);
      const fb = ROLE_FALLBACK[role] ?? ROLE_FALLBACK.body;
      let color = node.color;
      if (!color && t === "link") color = r.findVariable("link", "COLOR")?.name ?? r.findVariable("primary", "COLOR")?.name;
      return {
        kind: "text", path, name: node.name ?? (t === "link" ? "Link" : node.content.slice(0, 40)), content: node.content,
        textStyleId: st?.styleId, textStyleKey: st ? ds.styles.find((s) => s.id === st.styleId && s.remote)?.key : undefined,
        fontSize: st ? undefined : node.fontSize ?? fb.size, fontWeight: node.weight ? WEIGHT[node.weight as keyof typeof WEIGHT] : st ? undefined : fb.weight,
        fill: notePaint(r.resolvePaint(color, `${path}.color`, errors)),
        align: node.align ? node.align.toUpperCase() : undefined, hyperlink: node.href,
        width: w.size, height: h.size, sizingH: defaultH(stretch), sizingV: h.mode,
      } as ResolvedNode;
    }

    if (t === "divider" && !node.component && !node.role) {
      const m = r.findComponent({ role: "divider" }, path);
      if (!("error" in m)) {
        summary.instances[m.def.name] = (summary.instances[m.def.name] ?? 0) + 1;
        return { kind: "instance", path, name: "Divider", componentId: m.def.id, componentKey: m.def.remote ? m.def.key : undefined, remote: m.def.remote, componentName: m.set?.name ?? m.def.name, properties: {}, textOverrides: {}, sizingH: "fill" };
      }
      summary.primitives++;
      const fill = notePaint(r.resolvePaint(node.color ?? r.findVariable("border", "COLOR")?.name ?? "#E5E7EB", `${path}.color`, errors));
      return { kind: "rect", role: "divider", path, name: node.name ?? "Divider", height: 1, sizingH: parentDir === "HORIZONTAL" ? "fixed" : "fill", width: typeof node.width === "number" ? node.width : parentDir === "HORIZONTAL" ? 1 : undefined, fill };
    }

    if (t === "image") {
      summary.primitives++;
      return { kind: "rect", role: "image", path, name: node.name ?? `Image${node.alt ? ` – ${node.alt}` : ""}`, width: w.size ?? 120, height: h.size ?? 120, sizingH: w.mode ?? stretch ?? "fixed", sizingV: h.mode ?? "fixed", fill: notePaint(r.resolvePaint(node.fill ?? "#E5E7EB", `${path}.fill`, errors)), radius: noteNum(r.resolveNum(node.radius, `${path}.radius`, errors, "radius")) };
    }

    // component / component-instance / button / input / icon / link(component) / divider(component)
    const defaultRole = t === "button" ? "primary-action" : t === "input" ? "text-input" : t === "icon" ? "icon" : t === "link" ? "link" : t === "divider" ? "divider" : undefined;
    const node2 = t === "link" && node.content && !node.props ? { ...node, props: { label: node.content } } : node;
    const inst = instanceFrom(node2, path, node.component && !node.role ? (t === "button" && !node.variant ? "primary-action" : undefined) : defaultRole);
    if ("error" in inst) {
      if (node.allowFallback) {
        warnings.push(`${path}: ${inst.error.message} Drawing a labelled placeholder frame (allowFallback).`);
        summary.primitives++;
        const label = String(node.props?.label ?? node.props?.text ?? node.name ?? t);
        return { kind: "frame", role: "fallback", path, name: `⚠ ${node.name ?? t} (no DS component)`, layout: { direction: "HORIZONTAL", padding: { top: { value: 12 }, bottom: { value: 12 }, left: { value: 16 }, right: { value: 16 } }, primaryAlign: "CENTER", counterAlign: "CENTER" }, stroke: { hex: "#F59E0B" }, strokeWeight: 1, radius: { value: 8 }, sizingH: defaultH(stretch), sizingV: "hug", children: [{ kind: "text", path: `${path}.label`, name: "Label", content: label, fontSize: 14, fontWeight: "Medium" }] };
      }
      errors.push(inst.error);
      return undefined;
    }
    if (!inst.sizingH && stretch && (t === "input" || t === "button" || t === "divider" || inst.componentName.toLowerCase().includes("input"))) inst.sizingH = "fill";
    return inst;
  };

  const roots: ResolvedNode[] = [];
  plan.screens.forEach((s: any, i: number) => {
    const b = build(s, `screens[${i}]`, null);
    if (b) { roots.push(b); summary.screens.push(b.name); }
  });
  summary.tokensUsed = [...tokenSet];
  summary.textStylesUsed = [...styleSet];
  const body = JSON.stringify({ plan, roots, scanned: ds.scannedAt });
  const resolved: ResolvedPlan = { planId: `plan_${hash(body)}`, name: plan.name, target: { ...(plan.target ?? {}) }, screenGap: plan.screenGap, roots };
  return { ok: errors.length === 0, plan: errors.length === 0 ? resolved : undefined, errors, warnings, summary };
}
