// Deterministic executor: ResolvedPlan -> real Figma nodes, and Transformation[] -> edits.
// No model calls, no eval. Every operation is a fixed Plugin API call.
import type { ExecutionReport, Num, Paint as PlanPaint, ResolvedFrame, ResolvedGradient, ResolvedInstance, ResolvedNode, ResolvedPlan, ResolvedRect, ResolvedShadow, ResolvedSvg, ResolvedText, StructuredError, Transformation, TransformReport } from "@cde/core";

export class ExecError extends Error {
  constructor(public detail: StructuredError) { super(detail.message); }
}

const hexToRgb = (hex: string) => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { color: { r: n(0), g: n(2), b: n(4) }, opacity: h.length === 8 ? n(6) : 1 };
};

const WEIGHTS: [RegExp, number][] = [[/thin|hairline/, 100], [/extra ?light|ultra ?light/, 200], [/light/, 300], [/medium/, 500], [/semi ?bold|demi ?bold/, 600], [/extra ?bold|ultra ?bold/, 800], [/black|heavy/, 900], [/bold/, 700]];
export const weightOf = (style: string) => { const s = style.toLowerCase(); for (const [re, w] of WEIGHTS) if (re.test(s)) return w; return 400; };
const normStyle = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/** Pick the closest available style of a family: exact name (ignoring spaces), else nearest weight with matching italic. */
export function closestStyle(styles: string[], want: string, italic = false): string | undefined {
  if (!styles.length) return undefined;
  const target = normStyle(italic && !/italic/i.test(want) ? `${want} Italic` : want);
  const exact = styles.find((s) => normStyle(s) === target || (target === "regular" && normStyle(s) === "normal"));
  if (exact) return exact;
  const w = weightOf(want);
  const pool = styles.filter((s) => /italic|oblique/i.test(s) === italic);
  return [...(pool.length ? pool : styles)].sort((a, b) => Math.abs(weightOf(a) - w) - Math.abs(weightOf(b) - w) || a.length - b.length)[0];
}

function gradientPaint(g: ResolvedGradient): GradientPaint {
  // CSS angles: 0deg points up, 90deg right. Figma's gradient space runs left→right, so rotate about the centre.
  const t = ((g.angle - 90) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return {
    type: "GRADIENT_LINEAR",
    gradientTransform: [[c, s, 0.5 - 0.5 * c - 0.5 * s], [-s, c, 0.5 + 0.5 * s - 0.5 * c]],
    gradientStops: g.stops.map((st) => { const { color, opacity } = hexToRgb(st.hex); return { position: st.position, color: { ...color, a: opacity } }; }),
  };
}

function shadowEffect(s: ResolvedShadow): Effect {
  const { color, opacity } = hexToRgb(s.hex);
  const base = { color: { ...color, a: opacity }, offset: { x: s.x, y: s.y }, radius: s.blur, spread: s.spread, visible: true, blendMode: "NORMAL" as const };
  return s.type === "INNER_SHADOW" ? { type: "INNER_SHADOW", ...base } : { type: "DROP_SHADOW", ...base, showShadowBehindNode: false };
}

class Ctx {
  vars = new Map<string, Variable>();
  warnings: string[] = [];
  nodeIds: Record<string, string> = {};
  fonts = new Set<string>();
  missing = new Set<string>();
  private catalog?: Map<string, string[]>;

  /** Resolve a family + weight to a loaded, available font. Never throws: falls back to Inter with a warning. */
  async resolveFont(family: string, weight: string, italic: boolean, path: string): Promise<FontName> {
    if (!this.catalog) {
      this.catalog = new Map();
      try {
        for (const f of await figma.listAvailableFontsAsync()) this.catalog.set(f.fontName.family, [...(this.catalog.get(f.fontName.family) ?? []), f.fontName.style]);
      } catch { /* an empty catalog just means every lookup falls back below */ }
    }
    const catalog = this.catalog;
    const byLower = (fam: string) => [...catalog.keys()].find((k) => k.toLowerCase() === fam.toLowerCase());
    const tries: FontName[] = [];
    const fam = byLower(family);
    if (fam) tries.push({ family: fam, style: closestStyle(catalog.get(fam)!, weight, italic)! });
    else if (!this.missing.has(family.toLowerCase())) { this.missing.add(family.toLowerCase()); this.warnings.push(`Font "${family}" is not available in Figma; used Inter (first at ${path}).`); }
    const inter = byLower("Inter");
    tries.push({ family: "Inter", style: inter ? closestStyle(catalog.get(inter)!, weight, italic)! : "Regular" }, { family: "Inter", style: "Regular" });
    for (const f of tries) {
      try { await this.font(f); return f; } catch { /* try the next candidate */ }
    }
    this.warnings.push(`${path}: no font could be loaded; text left in the default font.`);
    return { family: "Inter", style: "Regular" };
  }

  async variable(id?: string, key?: string): Promise<Variable> {
    const k = key ?? id!;
    if (this.vars.has(k)) return this.vars.get(k)!;
    const v = key ? await figma.variables.importVariableByKeyAsync(key) : await figma.variables.getVariableByIdAsync(id!);
    if (!v) throw new ExecError({ type: "TOKEN_NOT_FOUND", message: `Variable ${k} not found in this file (was the Design System rescanned?).` });
    this.vars.set(k, v);
    return v;
  }

  async font(f: FontName) {
    const k = `${f.family}::${f.style}`;
    if (this.fonts.has(k)) return;
    await figma.loadFontAsync(f);
    this.fonts.add(k);
  }

  async fontsOf(t: TextNode) {
    if (t.characters.length === 0) { if (t.fontName !== figma.mixed) await this.font(t.fontName); return; }
    for (const f of t.getRangeAllFontNames(0, t.characters.length)) await this.font(f);
  }

  async solid(p: PlanPaint): Promise<SolidPaint> {
    if (p.hex) { const { color, opacity } = hexToRgb(p.hex); return { type: "SOLID", color, opacity }; }
    const v = await this.variable(p.variableId, p.variableKey);
    return figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", v);
  }

  async fill(node: GeometryMixin & MinimalFillsMixin & BaseNode, p: PlanPaint | undefined, kind: "fill" | "stroke" = "fill") {
    if (!p) return;
    if (p.styleId || p.styleKey) {
      const id = p.styleKey ? (await figma.importStyleByKeyAsync(p.styleKey)).id : p.styleId!;
      if (kind === "fill") await (node as any).setFillStyleIdAsync(id); else await (node as any).setStrokeStyleIdAsync(id);
      return;
    }
    const paint = await this.solid(p);
    if (kind === "fill") node.fills = [paint]; else (node as any).strokes = [paint];
  }

  async num(node: SceneNode, field: VariableBindableNodeField, n: Num | undefined) {
    if (!n) return;
    if (n.variableId || n.variableKey) { (node as any).setBoundVariable(field, await this.variable(n.variableId, n.variableKey)); return; }
    if (n.value !== undefined) (node as any)[field] = n.value;
  }

  async radius(node: SceneNode, n: Num | undefined) {
    if (!n) return;
    if (n.variableId || n.variableKey) {
      const v = await this.variable(n.variableId, n.variableKey);
      for (const f of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"] as const) (node as any).setBoundVariable(f, v);
    } else if (n.value !== undefined) (node as any).cornerRadius = n.value;
  }
}

function isAuto(n: BaseNode | null): boolean {
  return !!n && "layoutMode" in n && (n as FrameNode).layoutMode !== "NONE";
}

function applySizing(node: SceneNode, spec: ResolvedNode, ctx: Ctx) {
  const parentAuto = isAuto(node.parent);
  const selfAuto = isAuto(node);
  if (spec.width || spec.height) {
    const w = spec.width ?? node.width, h = spec.height ?? node.height;
    if ("resize" in node) (node as FrameNode).resize(Math.max(1, w), Math.max(1, h));
  }
  if (spec.absolute) {
    if (parentAuto) (node as FrameNode).layoutPositioning = "ABSOLUTE";
    node.x = spec.absolute.x; node.y = spec.absolute.y;
  }
  if (spec.opacity !== undefined && "opacity" in node) (node as FrameNode).opacity = spec.opacity;
  if ((spec.minWidth !== undefined || spec.maxWidth !== undefined) && "minWidth" in node) {
    if (parentAuto || selfAuto) {
      if (spec.minWidth !== undefined) (node as FrameNode).minWidth = spec.minWidth;
      if (spec.maxWidth !== undefined) (node as FrameNode).maxWidth = spec.maxWidth;
    } else ctx.warnings.push(`${spec.path}: minWidth/maxWidth need Auto Layout; ignored.`);
  }
  const set = (axis: "Horizontal" | "Vertical", mode?: string) => {
    if (!mode) return;
    const prop = `layoutSizing${axis}` as "layoutSizingHorizontal";
    if (!(prop in node)) return;
    if (mode === "fill") { if (parentAuto) (node as any)[prop] = "FILL"; else ctx.warnings.push(`${spec.path}: "fill" ignored (parent has no Auto Layout).`); }
    else if (mode === "hug") { if (selfAuto || node.type === "TEXT") (node as any)[prop] = "HUG"; }
    else if (mode === "fixed" && (parentAuto || selfAuto)) (node as any)[prop] = "FIXED";
  };
  set("Horizontal", spec.sizingH);
  set("Vertical", spec.sizingV);
}

/** Resize a section to its content plus padding. Sections never shrink below what they already cover unless asked. */
export function fitSection(s: SectionNode, pad = 80, grow = true) {
  const kids = s.children.filter((c) => c.visible !== false);
  if (!kids.length) return;
  const minX = Math.min(...kids.map((c) => c.x)), minY = Math.min(...kids.map((c) => c.y));
  // Keep content at least `pad` from the top-left edge: shift children, not the section, so nothing moves on the page.
  const dx = minX < pad ? pad - minX : 0, dy = minY < pad ? pad - minY : 0;
  if (dx || dy) for (const c of kids) { c.x += dx; c.y += dy; }
  const w = Math.max(...kids.map((c) => c.x + c.width)) + pad, h = Math.max(...kids.map((c) => c.y + c.height)) + pad;
  s.resizeWithoutConstraints(grow ? Math.max(w, s.width) : w, grow ? Math.max(h, s.height) : h);
}

/** A real Figma Section. Sections have no Auto Layout, so children are placed along the plan's direction. */
async function buildSection(n: ResolvedFrame, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<SectionNode> {
  const s = figma.createSection();
  parent.appendChild(s);
  ctx.nodeIds[n.path] = s.id;
  s.name = n.name;
  // Sections created through the API default to dark grey; use white unless the plan says otherwise.
  s.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  if (n.fill) { try { await ctx.fill(s as any, n.fill); } catch (e) { ctx.warnings.push(`${n.path}: section fill not applied (${(e as Error).message}).`); } }
  const pad = n.layout?.padding?.left?.value ?? 80, gap = n.layout?.gap?.value ?? 80;
  const vertical = n.layout?.direction === "VERTICAL";
  let at = pad;
  for (const c of n.children) {
    const node = await buildNode(c, s, ctx);
    if (c.absolute) continue;
    if (vertical) { node.x = pad; node.y = at; at += node.height + gap; } else { node.x = at; node.y = pad; at += node.width + gap; }
  }
  fitSection(s, pad, false);
  return s;
}

async function buildFrame(n: ResolvedFrame, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<FrameNode | SectionNode> {
  if (n.role === "section" && (parent.type === "PAGE" || parent.type === "SECTION")) return buildSection(n, parent, ctx);
  const f = figma.createFrame();
  parent.appendChild(f);
  ctx.nodeIds[n.path] = f.id;
  f.name = n.name;
  f.fills = [];
  f.clipsContent = !!n.clip;
  if (n.layout && n.layout.direction !== "NONE") {
    f.layoutMode = n.layout.direction;
    await ctx.num(f, "itemSpacing", n.layout.gap);
    const p = n.layout.padding;
    if (p) { await ctx.num(f, "paddingTop", p.top); await ctx.num(f, "paddingRight", p.right); await ctx.num(f, "paddingBottom", p.bottom); await ctx.num(f, "paddingLeft", p.left); }
    if (n.layout.primaryAlign) f.primaryAxisAlignItems = n.layout.primaryAlign;
    if (n.layout.counterAlign) f.counterAxisAlignItems = n.layout.counterAlign;
    if (n.layout.wrap && n.layout.direction === "HORIZONTAL") f.layoutWrap = "WRAP";
  }
  await ctx.fill(f, n.fill);
  if (n.gradient) f.fills = [...(f.fills as Paint[]), gradientPaint(n.gradient)];
  if (n.stroke) {
    await ctx.fill(f, n.stroke, "stroke");
    const w = n.strokeWeight ?? 1;
    f.strokeAlign = "INSIDE";
    if (n.strokeSides) {
      const on = new Set(n.strokeSides);
      f.strokeTopWeight = on.has("top") ? w : 0; f.strokeRightWeight = on.has("right") ? w : 0;
      f.strokeBottomWeight = on.has("bottom") ? w : 0; f.strokeLeftWeight = on.has("left") ? w : 0;
    } else f.strokeWeight = w;
    if (n.strokeWeights) {
      const s = n.strokeWeights;
      f.strokeTopWeight = s.top ?? 0; f.strokeRightWeight = s.right ?? 0; f.strokeBottomWeight = s.bottom ?? 0; f.strokeLeftWeight = s.left ?? 0;
    }
  }
  await ctx.radius(f, n.radius);
  if (n.effectStyleId) await f.setEffectStyleIdAsync(n.effectStyleId);
  else if (n.shadows?.length) f.effects = n.shadows.map(shadowEffect);
  applySizing(f, n, ctx);
  for (const c of n.children) await buildNode(c, f, ctx);
  return f;
}

async function buildText(n: ResolvedText, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<TextNode> {
  const t = figma.createText();
  parent.appendChild(t);
  ctx.nodeIds[n.path] = t.id;
  await ctx.font(t.fontName as FontName);
  if (n.textStyleId || n.textStyleKey) {
    const style = (n.textStyleKey ? await figma.importStyleByKeyAsync(n.textStyleKey) : await figma.getStyleByIdAsync(n.textStyleId!)) as TextStyle | null;
    if (!style) throw new ExecError({ type: "STYLE_NOT_FOUND", path: n.path, message: `Text style ${n.textStyleId} not found.` });
    await ctx.font(style.fontName);
    await t.setTextStyleIdAsync(style.id);
    // Explicit font fields override the style (the style stays linked, with overrides).
    if (n.fontFamily || n.fontWeight || n.italic !== undefined) t.fontName = await ctx.resolveFont(n.fontFamily ?? style.fontName.family, n.fontWeight ?? style.fontName.style, n.italic ?? /italic/i.test(style.fontName.style), n.path);
    if (n.fontSize) t.fontSize = n.fontSize;
  } else {
    t.fontName = await ctx.resolveFont(n.fontFamily ?? "Inter", n.fontWeight ?? "Regular", !!n.italic, n.path);
    if (n.fontSize) t.fontSize = n.fontSize;
  }
  if (n.lineHeight) t.lineHeight = n.lineHeight.unit === "AUTO" ? { unit: "AUTO" } : { unit: n.lineHeight.unit, value: n.lineHeight.value };
  if (n.letterSpacing) t.letterSpacing = { unit: n.letterSpacing.unit, value: n.letterSpacing.value };
  t.characters = n.content;
  t.name = n.name;
  if (n.align) t.textAlignHorizontal = n.align;
  await ctx.fill(t, n.fill);
  if (n.hyperlink && /^https?:\/\//.test(n.hyperlink)) t.hyperlink = { type: "URL", value: n.hyperlink };
  // Styled runs: each range gets its own font, size, colour and link on top of the base style.
  const base = t.fontName as FontName;
  for (const r of n.runs ?? []) {
    const end = Math.min(r.end, t.characters.length);
    if (r.start >= end) continue;
    if (r.fontFamily || r.fontWeight || r.italic !== undefined) t.setRangeFontName(r.start, end, await ctx.resolveFont(r.fontFamily ?? base.family, r.fontWeight ?? base.style, r.italic ?? /italic/i.test(base.style), n.path));
    if (r.fontSize) t.setRangeFontSize(r.start, end, r.fontSize);
    if (r.fill) t.setRangeFills(r.start, end, [await ctx.solid(r.fill)]);
    if (r.hyperlink && /^https?:\/\//.test(r.hyperlink)) t.setRangeHyperlink(r.start, end, { type: "URL", value: r.hyperlink });
  }
  t.textAutoResize = "WIDTH_AND_HEIGHT";
  if (n.sizingH === "fill" || n.width) t.textAutoResize = "HEIGHT";
  applySizing(t, n, ctx);
  return t;
}

async function getComponent(id: string, key: string | undefined, remote: boolean, path: string): Promise<ComponentNode> {
  let c: BaseNode | null = null;
  let importError: unknown;
  // Library import fails when the source library isn't enabled/published (e.g. in a copied file);
  // the remote component is usually still present in this file, so fall back to it by id.
  if (remote && key) { try { c = await figma.importComponentByKeyAsync(key); } catch (e) { importError = e; } }
  // A key can also name a component set (e.g. one found in a library search): use its default variant.
  if (!c && remote && key && !id) { try { c = (await figma.importComponentSetByKeyAsync(key)).defaultVariant; } catch (e) { importError ??= e; } }
  if (!c && id) { try { c = await figma.getNodeByIdAsync(id); } catch (e) { importError ??= e; } }
  if (!c) throw new ExecError({ type: "COMPONENT_NOT_FOUND", path, message: `Could not load component ${id}: ${importError instanceof Error ? importError.message : String(importError ?? "not in this file")}` });
  if (!c || c.type !== "COMPONENT" || c.removed) throw new ExecError({ type: "COMPONENT_NOT_FOUND", path, message: `Component ${id} no longer exists (rescan the Design System).` });
  return c;
}

const loose = (s: string) => s.split("#")[0].toLowerCase().replace(/[\s_-]+/g, "");

async function setInstanceContent(inst: InstanceNode, properties: Record<string, string | boolean>, overrides: Record<string, string>, path: string, ctx: Ctx, late: Record<string, string | boolean> = {}) {
  const texts = inst.findAllWithCriteria({ types: ["TEXT"] });
  for (const t of texts) await ctx.fontsOf(t);
  const available = inst.componentProperties;
  const valid: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (k in available) valid[k] = v;
    else ctx.warnings.push(`${path}: property "${k.split("#")[0]}" not on instance; skipped.`);
  }
  // Unscanned library component: match names now that the real properties are known.
  overrides = { ...overrides };
  for (const [k, v] of Object.entries(late)) {
    const key = Object.keys(available).find((a) => loose(a) === loose(k));
    if (key) {
      const def = available[key];
      if (def.type === "BOOLEAN") valid[key] = v === true || v === "true";
      else if (def.type === "VARIANT") {
        const opts = (inst.mainComponent?.parent?.type === "COMPONENT_SET" ? (inst.mainComponent.parent as ComponentSetNode).componentPropertyDefinitions[key]?.variantOptions : undefined) ?? [];
        const opt = opts.find((o) => loose(o) === loose(String(v)));
        if (opt || !opts.length) valid[key] = opt ?? String(v);
        else throw new ExecError({ type: "INVALID_VARIANT", path, message: `Variant ${key}="${v}" not found. Options: ${opts.join(" | ")}` });
      } else valid[key] = String(v);
    } else if (typeof v === "string" && texts.some((t) => loose(t.name) === loose(k))) overrides[texts.find((t) => loose(t.name) === loose(k))!.name] = v;
    else ctx.warnings.push(`${path}: "${k}" is not a property or text layer of this component; skipped. Available: ${Object.keys(available).map((a) => a.split("#")[0]).join(", ") || "none"}.`);
  }
  if (Object.keys(valid).length) inst.setProperties(valid);
  // A variant change can rebuild the instance's layers: look the text layers up again.
  const after = Object.keys(valid).length ? inst.findAllWithCriteria({ types: ["TEXT"] }) : texts;
  if (after !== texts) for (const t of after) await ctx.fontsOf(t);
  for (const [layer, value] of Object.entries(overrides)) {
    const t = after.find((x) => x.name === layer);
    if (!t) { ctx.warnings.push(`${path}: text layer "${layer}" not found in instance.`); continue; }
    t.characters = value;
  }
}

async function buildInstance(n: ResolvedInstance, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<InstanceNode> {
  const comp = await getComponent(n.componentId, n.componentKey, n.remote, n.path);
  const inst = comp.createInstance();
  parent.appendChild(inst);
  ctx.nodeIds[n.path] = inst.id;
  if (n.name && n.name !== comp.name) inst.name = n.name;
  await setInstanceContent(inst, n.properties, n.textOverrides, n.path, ctx, n.lateProps);
  applySizing(inst, n, ctx);
  return inst;
}

async function buildRect(n: ResolvedRect, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<RectangleNode> {
  const r = figma.createRectangle();
  parent.appendChild(r);
  ctx.nodeIds[n.path] = r.id;
  r.name = n.name;
  r.resize(n.width ?? 100, n.height ?? 1);
  await ctx.fill(r, n.fill);
  if (n.src) {
    // Keep the placeholder fill if the bytes can't be decoded; report instead of failing the plan.
    try {
      const m = n.src.match(/^data:image\/[\w.+-]+;base64,(.+)$/);
      if (!m) throw new Error("only data:image/…;base64 URLs reach the plugin (https is inlined by the server)");
      const img = figma.createImage(figma.base64Decode(m[1]));
      r.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: n.fit ?? "FILL" }];
    } catch (e) { ctx.warnings.push(`${n.path}: image could not be loaded (${(e as Error).message}); kept the placeholder.`); }
  }
  await ctx.radius(r, n.radius);
  applySizing(r, { ...n, width: undefined, height: undefined }, ctx);
  return r;
}

async function buildSvg(n: ResolvedSvg, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<SceneNode> {
  let node: SceneNode;
  try { node = figma.createNodeFromSvg(n.svg); }
  catch (e) {
    ctx.warnings.push(`${n.path}: invalid SVG (${(e as Error).message}); drew a placeholder.`);
    return buildRect({ kind: "rect", role: "icon-placeholder", path: n.path, name: n.name, width: n.width ?? 24, height: n.height ?? 24, fill: { hex: "#E5E7EB" } }, parent, ctx);
  }
  parent.appendChild(node);
  ctx.nodeIds[n.path] = node.id;
  node.name = n.name;
  if (n.fill && "findAll" in node) {
    const paint = await ctx.solid(n.fill);
    for (const v of (node as FrameNode).findAll((c) => c.type === "VECTOR")) {
      const vec = v as VectorNode;
      if ((vec.fills as Paint[]).length) vec.fills = [paint];
      if ((vec.strokes as Paint[]).length) vec.strokes = [paint];
    }
  }
  applySizing(node, n, ctx);
  return node;
}

function buildNode(n: ResolvedNode, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<SceneNode> {
  const run = async (): Promise<SceneNode> => {
    switch (n.kind) {
      case "frame": return buildFrame(n, parent, ctx);
      case "text": return buildText(n, parent, ctx);
      case "instance": return buildInstance(n, parent, ctx);
      case "rect": return buildRect(n, parent, ctx);
      case "svg": return buildSvg(n, parent, ctx);
    }
  };
  return run().catch((e) => {
    if (e instanceof ExecError) throw e;
    throw new ExecError({ type: "FIGMA_API_ERROR", path: n.path, message: (e as Error).message ?? String(e) });
  });
}

/** The page a node lives on. */
export function pageOf(n: BaseNode): PageNode | undefined {
  let p: BaseNode | null = n;
  while (p && p.type !== "PAGE") p = p.parent;
  return (p as PageNode) ?? undefined;
}

/** A page by id or exact name. */
export async function findPage(ref: string): Promise<PageNode> {
  await figma.loadAllPagesAsync();
  const page = figma.root.children.find((p) => p.id === ref) ?? figma.root.children.find((p) => p.name === ref);
  if (!page) throw new ExecError({ type: "NODE_NOT_FOUND", message: `No page "${ref}". Pages: ${figma.root.children.map((p) => p.name).join(", ")}. Create it with figma_pages.` });
  return page;
}

/** Mark nodes Layerwright created, so a session's leftovers can be listed and cleaned up later. */
export function tag(nodes: SceneNode[], meta?: { session?: string; run?: string }) {
  if (!meta?.session) return;
  const v = JSON.stringify({ session: meta.session, run: meta.run, at: new Date().toISOString() });
  for (const n of nodes) { try { n.setPluginData("layerwright", v); } catch { /* read-only node */ } }
}

export async function executePlan(plan: ResolvedPlan, meta?: { session?: string; run?: string }): Promise<ExecutionReport> {
  const ctx = new Ctx();
  let parent: BaseNode & ChildrenMixin = figma.currentPage;
  if (plan.target.parentId) {
    const p = await figma.getNodeByIdAsync(plan.target.parentId);
    if (!p || !("appendChild" in p)) throw new ExecError({ type: "NODE_NOT_FOUND", message: `Target parent ${plan.target.parentId} not found or cannot have children.` });
    parent = p as BaseNode & ChildrenMixin;
  }
  // Build on the requested page (or the target's page), never silently on whatever page the user has open.
  const page = plan.target.page ? await findPage(plan.target.page) : plan.target.parentId ? pageOf(parent) : undefined;
  if (page && plan.target.page && plan.target.parentId && pageOf(parent)?.id !== page.id) throw new ExecError({ type: "INVALID_PLAN", message: `Target parent ${plan.target.parentId} is on page "${pageOf(parent)?.name}", not "${page.name}".` });
  if (page && figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
  if (!plan.target.parentId && page) parent = page;
  const onPage = parent.type === "PAGE";
  let x = plan.target.x ?? (onPage ? Math.max(0, ...figma.currentPage.children.map((c) => c.x + c.width)) + (figma.currentPage.children.length ? 200 : 0) : 0);
  const y = plan.target.y ?? (onPage ? Math.min(0, ...figma.currentPage.children.map((c) => c.y)) : 0);
  const created: SceneNode[] = [];
  try {
    for (const root of plan.roots) {
      const node = await buildNode(root, parent, ctx);
      created.push(node);
      // A root with an explicit absolute position keeps it; the others are laid out side by side.
      if (root.absolute) continue;
      if (onPage || !isAuto(parent)) { node.x = x; node.y = y; x += node.width + (plan.screenGap ?? 80); }
    }
    // Content added to a section: grow the section so it still contains everything.
    if (parent.type === "SECTION") fitSection(parent as SectionNode);
    // Inserts: nodes into existing parents (slots), in the same run and undo step.
    for (const ins of plan.inserts ?? []) {
      const p = await figma.getNodeByIdAsync(ins.parentId);
      if (!p || !("appendChild" in p)) throw new ExecError({ type: "NODE_NOT_FOUND", message: `Insert parent ${ins.parentId} not found or cannot have children.` });
      const host = p as BaseNode & ChildrenMixin;
      let at = ins.index;
      for (const r of ins.roots) {
        const node = await buildNode(r, host, ctx);
        created.push(node);
        if (at !== undefined) host.insertChild(Math.min(at++, host.children.length - 1), node);
      }
      if (host.type === "SECTION") fitSection(host as SectionNode);
    }
  } catch (e) {
    // Never leave a half-built design behind: remove only what this run created.
    for (const n of created) if (!n.removed) n.remove();
    const partial = Object.values(ctx.nodeIds);
    for (const id of partial) { const n = await figma.getNodeByIdAsync(id); if (n && !n.removed) (n as SceneNode).remove(); }
    const d = e instanceof ExecError ? e.detail : { type: "FIGMA_API_ERROR" as const, message: String(e) };
    throw new ExecError({ ...d, message: `${d.message} (execution rolled back; nothing was left on the canvas)` });
  }
  tag(created, meta);
  if (onPage || parent.type === "SECTION") { figma.currentPage.selection = created; figma.viewport.scrollAndZoomIntoView(created); }
  figma.commitUndo(); // one undo step for the whole plan
  return { createdRootIds: created.map((n) => n.id), page: { id: figma.currentPage.id, name: figma.currentPage.name }, nodeIds: ctx.nodeIds, warnings: ctx.warnings };
}

export async function applyTransformations(list: Transformation[]): Promise<TransformReport> {
  const ctx = new Ctx();
  const report: TransformReport = { applied: [], failed: [], hiddenOriginals: [] };
  for (const t of list) {
    try {
      const node = (await figma.getNodeByIdAsync(t.nodeId)) as SceneNode | null;
      if (!node || node.removed) throw new Error(`node ${t.nodeId} not found`);
      switch (t.op) {
        case "replace_with_instance": {
          const parent = node.parent as (BaseNode & ChildrenMixin) | null;
          if (!parent) throw new Error("node has no parent");
          const comp = await getComponent(t.componentId, t.componentKey, t.remote, t.nodeName);
          const inst = comp.createInstance();
          parent.insertChild(parent.children.indexOf(node), inst);
          if (!isAuto(parent)) { inst.x = node.x; inst.y = node.y; }
          await setInstanceContent(inst, t.properties, t.textOverrides, t.nodeName, ctx);
          if ("layoutSizingHorizontal" in node && isAuto(parent)) {
            const sh = (node as FrameNode).layoutSizingHorizontal;
            if (sh === "FILL") inst.layoutSizingHorizontal = "FILL";
          } else if (Math.abs(inst.width - node.width) > 1) { try { inst.resize(node.width, inst.height); } catch { /* fixed-size component */ } }
          // Non-destructive: keep the original, hidden and labelled, so the user can compare or restore.
          node.visible = false;
          node.name = `${node.name} [replaced → ${t.componentName}]`;
          report.hiddenOriginals.push(node.id);
          report.applied.push({ id: t.id, nodeId: t.nodeId, newNodeId: inst.id });
          break;
        }
        case "bind_number": {
          if (t.field === "cornerRadius") await ctx.radius(node, { variableId: t.variableId, variableKey: t.variableKey });
          else await ctx.num(node, t.field, { variableId: t.variableId, variableKey: t.variableKey });
          report.applied.push({ id: t.id, nodeId: t.nodeId });
          break;
        }
        case "bind_fill": {
          const n = node as GeometryMixin & SceneNode;
          const fills = (n.fills as readonly Paint[]).slice();
          if (!fills.length || fills[0].type !== "SOLID") throw new Error("first fill is not a solid color");
          fills[0] = figma.variables.setBoundVariableForPaint(fills[0] as SolidPaint, "color", await ctx.variable(t.variableId, t.variableKey));
          n.fills = fills;
          report.applied.push({ id: t.id, nodeId: t.nodeId });
          break;
        }
        case "apply_text_style": {
          if (node.type !== "TEXT") throw new Error("not a text node");
          const style = (t.styleKey ? await figma.importStyleByKeyAsync(t.styleKey) : await figma.getStyleByIdAsync(t.styleId)) as TextStyle | null;
          if (!style) throw new Error(`text style ${t.styleName} not found`);
          await ctx.fontsOf(node);
          await ctx.font(style.fontName);
          await node.setTextStyleIdAsync(style.id);
          report.applied.push({ id: t.id, nodeId: t.nodeId });
          break;
        }
        case "convert_auto_layout": {
          if (node.type !== "FRAME") throw new Error("not a frame");
          const w = node.width, h = node.height;
          const kids = [...node.children].sort((a, b) => (t.direction === "VERTICAL" ? a.y - b.y : a.x - b.x));
          kids.forEach((k, i) => node.insertChild(i, k)); // Auto Layout orders by index, so reorder by position first
          node.layoutMode = t.direction;
          node.itemSpacing = t.gap;
          node.paddingTop = t.padding.top; node.paddingRight = t.padding.right; node.paddingBottom = t.padding.bottom; node.paddingLeft = t.padding.left;
          node.primaryAxisSizingMode = "FIXED"; node.counterAxisSizingMode = "FIXED";
          node.resize(w, h);
          report.applied.push({ id: t.id, nodeId: t.nodeId });
          break;
        }
      }
    } catch (e) {
      report.failed.push({ id: t.id, error: (e as Error).message ?? String(e) });
    }
  }
  figma.commitUndo();
  return report;
}
