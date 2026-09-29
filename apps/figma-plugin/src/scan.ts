// Design System scanner + compact inspector. Runs in the Figma plugin sandbox.
import type { ComponentDefinition, ComponentSetDefinition, NodeSnapshot, PropertyDefinition, StyleDefinition, TypographyDefinition, VariableCollectionDefinition, VariableDefinition } from "@cde/core";

const h2 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
export const toHex = (c: RGB | RGBA, opacity = 1) => {
  const a = ("a" in c ? c.a : 1) * opacity;
  return `#${h2(c.r)}${h2(c.g)}${h2(c.b)}${a < 0.999 ? h2(a) : ""}`;
};

function pageOf(n: BaseNode): string | undefined {
  let p: BaseNode | null = n;
  while (p && p.type !== "PAGE") p = p.parent;
  return p?.name;
}

function propDefs(defs: ComponentPropertyDefinitions): PropertyDefinition[] {
  return Object.entries(defs).map(([key, d]) => ({ key, name: key.split("#")[0], type: d.type as PropertyDefinition["type"], defaultValue: d.defaultValue, options: d.variantOptions }));
}

function layoutOf(n: FrameNode | ComponentNode | ComponentSetNode | InstanceNode) {
  if (!("layoutMode" in n)) return undefined;
  return { mode: n.layoutMode, gap: n.layoutMode === "NONE" ? undefined : n.itemSpacing, padding: n.layoutMode === "NONE" ? undefined : { top: n.paddingTop, right: n.paddingRight, bottom: n.paddingBottom, left: n.paddingLeft } };
}

function componentDef(c: ComponentNode): ComponentDefinition {
  const inSet = c.parent?.type === "COMPONENT_SET";
  let properties: PropertyDefinition[] | undefined;
  try { if (!inSet) properties = propDefs(c.componentPropertyDefinitions); } catch { /* not accessible */ }
  let textLayers: string[] = [];
  try { textLayers = c.findAllWithCriteria({ types: ["TEXT"] }).slice(0, 12).map((t) => t.name); } catch { /* remote */ }
  let variants: Record<string, string> | undefined;
  if (inSet) {
    // A component set with errors (e.g. duplicate variants) throws here; fall back to the "Key=Value, …" name.
    try { variants = c.variantProperties ?? undefined; } catch {
      variants = Object.fromEntries(c.name.split(",").map((p) => p.split("=").map((s) => s.trim())).filter((kv) => kv.length === 2 && kv[0]));
    }
  }
  return {
    id: c.id, key: c.key, name: c.name, description: c.description || undefined, remote: c.remote, page: pageOf(c),
    componentSetId: inSet ? c.parent!.id : undefined, componentSet: inSet ? c.parent!.name : undefined,
    variants, properties,
    dimensions: { width: c.width, height: c.height }, layout: layoutOf(c), textLayers,
  };
}

function setDef(s: ComponentSetNode): ComponentSetDefinition {
  let properties: PropertyDefinition[] = [];
  try { properties = propDefs(s.componentPropertyDefinitions); } catch { /* ignore */ }
  let defaultVariantId: string | undefined;
  try { defaultVariantId = s.defaultVariant?.id; } catch { /* ignore */ }
  return { id: s.id, key: s.key, name: s.name, description: s.description || undefined, remote: s.remote, page: pageOf(s), properties, variantIds: s.children.map((c) => c.id), defaultVariantId };
}

export async function scanDesignSystem(opts: { includeLibraries?: boolean; maxInstances?: number } = {}) {
  await figma.loadAllPagesAsync();
  const components: ComponentDefinition[] = [];
  const componentSets: ComponentSetDefinition[] = [];
  const seen = new Set<string>();
  const addSet = (s: ComponentSetNode) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    componentSets.push(setDef(s));
    for (const c of s.children) if (c.type === "COMPONENT" && !seen.has(c.id)) { seen.add(c.id); components.push(componentDef(c)); }
  };
  const addComp = (c: ComponentNode) => {
    if (c.parent?.type === "COMPONENT_SET") return addSet(c.parent);
    if (seen.has(c.id)) return;
    seen.add(c.id);
    components.push(componentDef(c));
  };
  for (const n of figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })) n.type === "COMPONENT_SET" ? addSet(n) : addComp(n);

  // Library components actually used in this file (reachable through instances).
  const warnings: string[] = [];
  // Current page first: the components the user is working with are the ones that must resolve.
  const onPage = figma.currentPage.findAllWithCriteria({ types: ["INSTANCE"] });
  const pageIds = new Set(onPage.map((i) => i.id));
  const instances = [...onPage, ...figma.root.findAllWithCriteria({ types: ["INSTANCE"] }).filter((i) => !pageIds.has(i.id))];
  const cap = opts.maxInstances ?? Math.max(3000, Math.min(onPage.length, 30000));
  const mains = new Set<string>();
  for (const inst of instances.slice(0, cap)) {
    try {
      const main = await inst.getMainComponentAsync();
      if (!main || !main.remote || mains.has(main.id)) continue;
      mains.add(main.id);
      addComp(main);
    } catch { /* detached / unavailable */ }
  }
  if (instances.length > cap) warnings.push(`Only the first ${cap} of ${instances.length} instances were checked for library components.`);

  // Variables (local + optionally enabled libraries).
  const variableCollections: VariableCollectionDefinition[] = [];
  const variables: VariableDefinition[] = [];
  const locals = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(locals.map((v) => [v.id, v]));
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const colById = new Map(cols.map((c) => [c.id, c]));
  for (const c of cols) variableCollections.push({ id: c.id, name: c.name, remote: false, modes: c.modes.map((m) => ({ id: m.modeId, name: m.name })), defaultModeId: c.defaultModeId });
  const fmt = (val: VariableValue | undefined, type: string): unknown => {
    if (val === undefined) return undefined;
    if (typeof val === "object" && "type" in val && val.type === "VARIABLE_ALIAS") return { alias: val.id };
    if (type === "COLOR" && typeof val === "object" && "r" in val) return toHex(val as RGBA);
    return val;
  };
  const resolveValue = async (v: Variable, depth = 0): Promise<unknown> => {
    const col = colById.get(v.variableCollectionId);
    const raw = v.valuesByMode[col?.defaultModeId ?? Object.keys(v.valuesByMode)[0]];
    const f = fmt(raw, v.resolvedType);
    if (f && typeof f === "object" && "alias" in f && depth < 6) {
      const target = byId.get((f as { alias: string }).alias) ?? (await figma.variables.getVariableByIdAsync((f as { alias: string }).alias));
      return target ? resolveValue(target, depth + 1) : undefined;
    }
    return f;
  };
  for (const v of locals) {
    const col = colById.get(v.variableCollectionId);
    const valuesByMode: Record<string, unknown> = {};
    for (const m of col?.modes ?? []) {
      const f = fmt(v.valuesByMode[m.modeId], v.resolvedType);
      valuesByMode[m.name] = f && typeof f === "object" && "alias" in f ? `alias:${byId.get((f as { alias: string }).alias)?.name ?? "library"}` : f;
    }
    variables.push({ id: v.id, key: v.key, name: v.name, collection: col?.name ?? "", type: v.resolvedType as VariableDefinition["type"], remote: false, value: await resolveValue(v), valuesByMode: (col?.modes.length ?? 0) > 1 ? valuesByMode : undefined, scopes: v.scopes as string[], description: v.description || undefined });
  }
  if (opts.includeLibraries !== false) {
    try {
      const libs = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      for (const lc of libs) {
        variableCollections.push({ id: `lib:${lc.key}`, name: `${lc.libraryName} / ${lc.name}`, remote: true, modes: [] });
        const vs = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(lc.key);
        for (const v of vs) variables.push({ id: `lib:${v.key}`, key: v.key, name: v.name, collection: `${lc.libraryName} / ${lc.name}`, type: v.resolvedType as VariableDefinition["type"], remote: true });
      }
    } catch (e) { warnings.push(`Library variables unavailable: ${(e as Error).message}`); }
  }

  // Styles
  const styles: StyleDefinition[] = [];
  const typography: TypographyDefinition[] = [];
  for (const s of await figma.getLocalTextStylesAsync()) {
    const lh = s.lineHeight.unit === "AUTO" ? "AUTO" : s.lineHeight.unit === "PIXELS" ? s.lineHeight.value : `${s.lineHeight.value}%`;
    styles.push({ id: s.id, key: s.key, name: s.name, type: "TEXT", remote: s.remote, description: s.description || undefined, value: `${s.fontName.family} ${s.fontName.style} ${s.fontSize}/${lh}` });
    typography.push({ styleId: s.id, name: s.name, fontFamily: s.fontName.family, fontStyle: s.fontName.style, fontSize: s.fontSize, lineHeight: lh, letterSpacing: s.letterSpacing.unit === "PIXELS" ? s.letterSpacing.value : undefined });
  }
  for (const s of await figma.getLocalPaintStylesAsync()) {
    const p = s.paints[0];
    styles.push({ id: s.id, key: s.key, name: s.name, type: "PAINT", remote: s.remote, description: s.description || undefined, value: p?.type === "SOLID" ? toHex(p.color, p.opacity ?? 1) : p?.type });
  }
  for (const s of await figma.getLocalEffectStylesAsync()) styles.push({ id: s.id, key: s.key, name: s.name, type: "EFFECT", remote: s.remote, value: s.effects.map((e) => e.type).join(",") });

  return { fileName: figma.root.name, scannedAt: new Date().toISOString(), components, componentSets, variableCollections, variables, styles, typography, warnings };
}

// ---------------- Inspector ----------------

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "SECTION", "COMPONENT", "COMPONENT_SET", "PAGE", "BOOLEAN_OPERATION"]);

function paints(p: readonly Paint[] | typeof figma.mixed | undefined): string[] | undefined {
  if (!p || p === figma.mixed || !Array.isArray(p)) return undefined;
  const out = (p as Paint[]).filter((x) => x.visible !== false).map((x) => (x.type === "SOLID" ? toHex(x.color, x.opacity ?? 1) : x.type.toLowerCase()));
  return out.length ? out : undefined;
}

export async function snapshot(node: BaseNode, opts: { depth?: number; maxNodes?: number; expandInstances?: boolean } = {}): Promise<NodeSnapshot> {
  let budget = opts.maxNodes ?? 400;
  const varNames = new Map<string, string>();
  const varName = async (id: string) => {
    if (!varNames.has(id)) varNames.set(id, (await figma.variables.getVariableByIdAsync(id))?.name ?? id);
    return varNames.get(id)!;
  };
  const walk = async (n: BaseNode, depth: number, parentAbs?: { x: number; y: number }): Promise<NodeSnapshot> => {
    budget--;
    const s: NodeSnapshot = { id: n.id, type: n.type, name: n.name };
    const sn = n as SceneNode;
    if ("x" in sn) { s.x = Math.round(sn.x); s.y = Math.round(sn.y); s.w = Math.round(sn.width); s.h = Math.round(sn.height); }
    if ("visible" in sn && !sn.visible) s.visible = false;
    if ("layoutMode" in sn) {
      const f = sn as FrameNode;
      s.layout = { mode: f.layoutMode, primaryAlign: f.primaryAxisAlignItems, counterAlign: f.counterAxisAlignItems, sizingH: f.layoutSizingHorizontal, sizingV: f.layoutSizingVertical };
      if (f.layoutMode !== "NONE") { s.layout.gap = f.itemSpacing; s.layout.padding = { top: f.paddingTop, right: f.paddingRight, bottom: f.paddingBottom, left: f.paddingLeft }; }
    }
    if ("fills" in sn) s.fills = paints(sn.fills as readonly Paint[]);
    if ("strokes" in sn) s.strokes = paints(sn.strokes);
    if ("cornerRadius" in sn && typeof sn.cornerRadius === "number" && sn.cornerRadius > 0) s.radius = sn.cornerRadius;
    if ("strokeWeight" in sn && typeof sn.strokeWeight === "number" && s.strokes) s.strokeWeight = sn.strokeWeight;
    if ("opacity" in sn && sn.opacity < 1) s.opacity = Math.round(sn.opacity * 100) / 100;
    if ("clipsContent" in sn && (sn as FrameNode).clipsContent && n.type !== "INSTANCE") s.clip = true;
    if ("fillStyleId" in sn && typeof sn.fillStyleId === "string" && sn.fillStyleId) s.fillStyle = sn.fillStyleId;
    if ("reactions" in sn && (sn as ReactionMixin).reactions.length) {
      const out: NonNullable<NodeSnapshot["reactions"]> = [];
      for (const r of (sn as ReactionMixin).reactions) {
        const a = r.actions?.[0] ?? r.action;
        const trig = r.trigger as { type: string; timeout?: number; delay?: number } | null;
        const item: NonNullable<NodeSnapshot["reactions"]>[number] = { trigger: trig?.type, delay: trig?.timeout ?? (trig?.delay || undefined), action: a?.type === "NODE" ? a.navigation : a?.type };
        if (a?.type === "NODE" && a.destinationId) { item.to = a.destinationId; item.toName = (await figma.getNodeByIdAsync(a.destinationId))?.name; }
        if (a?.type === "URL") item.url = a.url;
        if (a?.type === "NODE" && a.transition) item.transition = { type: a.transition.type, direction: "direction" in a.transition ? a.transition.direction : undefined, duration: Math.round(a.transition.duration * 1000), easing: a.transition.easing.type };
        out.push(item);
      }
      s.reactions = out;
    }
    if ("boundVariables" in sn && sn.boundVariables) {
      const b: Record<string, string> = {};
      for (const [k, v] of Object.entries(sn.boundVariables)) {
        const alias = Array.isArray(v) ? v[0] : v;
        if (alias && typeof alias === "object" && "id" in alias) b[k] = await varName((alias as VariableAlias).id);
      }
      if (Object.keys(b).length) s.bound = b;
    }
    if (n.type === "TEXT") {
      const t = n as TextNode;
      s.text = { chars: t.characters.length > 300 ? `${t.characters.slice(0, 300)}…` : t.characters, fontSize: typeof t.fontSize === "number" ? t.fontSize : undefined, font: t.fontName !== figma.mixed ? `${t.fontName.family} ${t.fontName.style}` : "mixed",
        lineHeight: t.lineHeight === figma.mixed ? "mixed" : t.lineHeight.unit === "AUTO" ? "AUTO" : t.lineHeight.unit === "PIXELS" ? Math.round(t.lineHeight.value * 10) / 10 : `${t.lineHeight.value}%` };
      s.text.align = t.textAlignHorizontal;
      s.text.autoResize = t.textAutoResize;
      if (t.letterSpacing !== figma.mixed && t.letterSpacing.value) s.text.letterSpacing = t.letterSpacing.unit === "PIXELS" ? t.letterSpacing.value : Math.round((t.letterSpacing.value / 100) * (typeof t.fontSize === "number" ? t.fontSize : 16) * 100) / 100;
      if (typeof t.textStyleId === "string" && t.textStyleId) { s.text.styleId = t.textStyleId; s.text.style = (await figma.getStyleByIdAsync(t.textStyleId))?.name; }
    }
    if (n.type === "INSTANCE") {
      const i = n as InstanceNode;
      let main: ComponentNode | null = null;
      try { main = await i.getMainComponentAsync(); } catch { /* unavailable library */ }
      const props: Record<string, unknown> = {};
      const variants: Record<string, string> = {};
      try {
        for (const [k, p] of Object.entries(i.componentProperties)) (p.type === "VARIANT" ? (variants[k] = String(p.value)) : (props[k] = p.value));
      } catch {
        // A component set with errors (e.g. duplicate variants) can't report properties: read "Key=Value, …" from the name.
        for (const kv of (main?.name ?? "").split(",")) { const [k, v] = kv.split("=").map((x) => x.trim()); if (k && v) variants[k] = v; }
        s.warnings = [...(s.warnings ?? []), "component set has errors; variants read from the component name"];
      }
      s.instance = { componentId: main?.id, component: main?.name, componentSet: main?.parent?.type === "COMPONENT_SET" ? main.parent.name : undefined, componentSetId: main?.parent?.type === "COMPONENT_SET" ? main.parent.id : undefined, variants: Object.keys(variants).length ? variants : undefined, props: Object.keys(props).length ? props : undefined };
      if (!opts.expandInstances || depth <= 0) return s; // instance internals only on request
      // What differs from the main component: which layers have overrides, and which fields.
      const ov: Record<string, string[]> = {};
      try { for (const o of i.overrides) { const t = await figma.getNodeByIdAsync(o.id); ov[t && t.id !== i.id ? t.name : "(self)"] = o.overriddenFields as string[]; } } catch { /* not available */ }
      if (Object.keys(ov).length) s.instance.overrides = ov;
    }
    if ("children" in n && (CONTAINER_TYPES.has(n.type) || n.type === "INSTANCE")) {
      const kids = (n as ChildrenMixin).children;
      if (depth <= 0 || budget <= 0) { if (kids.length) s.truncated = kids.length; return s; }
      s.children = [];
      for (const c of kids) {
        if (budget <= 0) { s.truncated = kids.length - s.children.length; break; }
        s.children.push(await walk(c, depth - 1, parentAbs));
      }
    }
    return s;
  };
  return walk(node, opts.depth ?? 6);
}
