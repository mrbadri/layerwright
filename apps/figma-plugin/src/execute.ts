// Deterministic executor: ResolvedPlan -> real Figma nodes, and Transformation[] -> edits.
// No model calls, no eval. Every operation is a fixed Plugin API call.
import type { ExecutionReport, Num, Paint as PlanPaint, ResolvedFrame, ResolvedInstance, ResolvedNode, ResolvedPlan, ResolvedRect, ResolvedText, StructuredError, Transformation, TransformReport } from "@cde/core";

export class ExecError extends Error {
  constructor(public detail: StructuredError) { super(detail.message); }
}

const hexToRgb = (hex: string) => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { color: { r: n(0), g: n(2), b: n(4) }, opacity: h.length === 8 ? n(6) : 1 };
};

class Ctx {
  vars = new Map<string, Variable>();
  warnings: string[] = [];
  nodeIds: Record<string, string> = {};
  fonts = new Set<string>();

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

async function buildFrame(n: ResolvedFrame, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<FrameNode> {
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
  if (n.stroke) { await ctx.fill(f, n.stroke, "stroke"); f.strokeWeight = n.strokeWeight ?? 1; }
  await ctx.radius(f, n.radius);
  if (n.effectStyleId) await f.setEffectStyleIdAsync(n.effectStyleId);
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
  } else {
    const font = { family: "Inter", style: n.fontWeight ?? "Regular" };
    try { await ctx.font(font); t.fontName = font; } catch { ctx.warnings.push(`${n.path}: font ${font.family} ${font.style} unavailable; using Inter Regular.`); }
    if (n.fontSize) t.fontSize = n.fontSize;
  }
  t.characters = n.content;
  t.name = n.name;
  if (n.align) t.textAlignHorizontal = n.align;
  await ctx.fill(t, n.fill);
  if (n.hyperlink && /^https?:\/\//.test(n.hyperlink)) t.hyperlink = { type: "URL", value: n.hyperlink };
  t.textAutoResize = "WIDTH_AND_HEIGHT";
  if (n.sizingH === "fill" || n.width) t.textAutoResize = "HEIGHT";
  applySizing(t, n, ctx);
  return t;
}

async function getComponent(id: string, key: string | undefined, remote: boolean, path: string): Promise<ComponentNode> {
  let c: BaseNode | null = null;
  try { c = remote && key ? await figma.importComponentByKeyAsync(key) : await figma.getNodeByIdAsync(id); } catch (e) { throw new ExecError({ type: "COMPONENT_NOT_FOUND", path, message: `Could not load component ${id}: ${(e as Error).message}` }); }
  if (!c || c.type !== "COMPONENT") throw new ExecError({ type: "COMPONENT_NOT_FOUND", path, message: `Component ${id} no longer exists (rescan the Design System).` });
  return c;
}

async function setInstanceContent(inst: InstanceNode, properties: Record<string, string | boolean>, overrides: Record<string, string>, path: string, ctx: Ctx) {
  const texts = inst.findAllWithCriteria({ types: ["TEXT"] });
  for (const t of texts) await ctx.fontsOf(t);
  const available = inst.componentProperties;
  const valid: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (k in available) valid[k] = v;
    else ctx.warnings.push(`${path}: property "${k.split("#")[0]}" not on instance; skipped.`);
  }
  if (Object.keys(valid).length) inst.setProperties(valid);
  for (const [layer, value] of Object.entries(overrides)) {
    const t = texts.find((x) => x.name === layer);
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
  await setInstanceContent(inst, n.properties, n.textOverrides, n.path, ctx);
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
  await ctx.radius(r, n.radius);
  applySizing(r, { ...n, width: undefined, height: undefined }, ctx);
  return r;
}

function buildNode(n: ResolvedNode, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<SceneNode> {
  const run = async (): Promise<SceneNode> => {
    switch (n.kind) {
      case "frame": return buildFrame(n, parent, ctx);
      case "text": return buildText(n, parent, ctx);
      case "instance": return buildInstance(n, parent, ctx);
      case "rect": return buildRect(n, parent, ctx);
    }
  };
  return run().catch((e) => {
    if (e instanceof ExecError) throw e;
    throw new ExecError({ type: "FIGMA_API_ERROR", path: n.path, message: (e as Error).message ?? String(e) });
  });
}

export async function executePlan(plan: ResolvedPlan): Promise<ExecutionReport> {
  const ctx = new Ctx();
  let parent: BaseNode & ChildrenMixin = figma.currentPage;
  if (plan.target.parentId) {
    const p = await figma.getNodeByIdAsync(plan.target.parentId);
    if (!p || !("appendChild" in p)) throw new ExecError({ type: "NODE_NOT_FOUND", message: `Target parent ${plan.target.parentId} not found or cannot have children.` });
    parent = p as BaseNode & ChildrenMixin;
  }
  const onPage = parent.type === "PAGE";
  let x = plan.target.x ?? (onPage ? Math.max(0, ...figma.currentPage.children.map((c) => c.x + c.width)) + (figma.currentPage.children.length ? 200 : 0) : 0);
  const y = plan.target.y ?? (onPage ? Math.min(0, ...figma.currentPage.children.map((c) => c.y)) : 0);
  const created: SceneNode[] = [];
  try {
    for (const root of plan.roots) {
      const node = await buildNode(root, parent, ctx);
      created.push(node);
      if (onPage || !isAuto(parent)) { node.x = x; node.y = y; x += node.width + (plan.screenGap ?? 80); }
    }
  } catch (e) {
    // Never leave a half-built design behind: remove only what this run created.
    for (const n of created) if (!n.removed) n.remove();
    const partial = Object.values(ctx.nodeIds);
    for (const id of partial) { const n = await figma.getNodeByIdAsync(id); if (n && !n.removed) (n as SceneNode).remove(); }
    const d = e instanceof ExecError ? e.detail : { type: "FIGMA_API_ERROR" as const, message: String(e) };
    throw new ExecError({ ...d, message: `${d.message} (execution rolled back; nothing was left on the canvas)` });
  }
  if (onPage) { figma.currentPage.selection = created; figma.viewport.scrollAndZoomIntoView(created); }
  figma.commitUndo(); // one undo step for the whole plan
  return { createdRootIds: created.map((n) => n.id), nodeIds: ctx.nodeIds, warnings: ctx.warnings };
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
