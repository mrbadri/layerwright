// Executor tests against a strict in-memory mock of the Figma Plugin API.
// The mock enforces the rules that most often break real plugins: fonts must be loaded
// before text writes, FILL needs an auto-layout parent, HUG needs auto-layout/text,
// setProperties rejects unknown keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, validatePlan, analyzeDesign, type ResolvedPlan } from "@cde/core";
import { fixtureDs, loginPlan } from "../../../packages/core/test/fixture.ts";

let seq = 0;
const nodes = new Map<string, any>();
const loaded = new Set<string>();
const MIXED = Symbol("mixed");

class N {
  id: string; parent: any = null; children: any[] = []; removed = false; visible = true; name = "";
  x = 0; y = 0; width = 100; height = 100; fills: any[] = []; strokes: any[] = []; boundVariables: any = {};
  layoutMode = "NONE"; itemSpacing = 0; paddingTop = 0; paddingRight = 0; paddingBottom = 0; paddingLeft = 0; cornerRadius = 0;
  private _lh = "FIXED"; private _lv = "FIXED";
  constructor(public type: string, id?: string) { this.id = id ?? `n:${++seq}`; nodes.set(this.id, this); }
  appendChild(c: any) { this.insertChild(this.children.length, c); }
  insertChild(i: number, c: any) { if (c.parent) c.parent.children = c.parent.children.filter((x: any) => x !== c); this.children.splice(i, 0, c); c.parent = this; }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((x: any) => x !== this); }
  resize(w: number, h: number) { this.width = w; this.height = h; }
  setBoundVariable(f: string, v: any) { this.boundVariables[f] = { type: "VARIABLE_ALIAS", id: v.id }; }
  findAllWithCriteria({ types }: any): any[] { return this.children.flatMap((c) => [...(types.includes(c.type) ? [c] : []), ...c.findAllWithCriteria({ types })]); }
  get layoutSizingHorizontal() { return this._lh; }
  set layoutSizingHorizontal(v: string) { this.checkSizing(v); this._lh = v; }
  get layoutSizingVertical() { return this._lv; }
  set layoutSizingVertical(v: string) { this.checkSizing(v); this._lv = v; }
  private checkSizing(v: string) {
    if (v === "FILL" && (!this.parent || this.parent.layoutMode === "NONE")) throw new Error("FILL can only be set on children of auto-layout frames");
    if (v === "HUG" && this.layoutMode === "NONE" && this.type !== "TEXT") throw new Error("HUG requires auto-layout or text");
  }
  async setEffectStyleIdAsync() {}
  async setFillStyleIdAsync() {}
}

class T extends N {
  fontName: any = { family: "Inter", style: "Regular" }; fontSize = 12; textAutoResize = "NONE"; textAlignHorizontal = "LEFT"; textStyleId = ""; hyperlink: any = null;
  private _c = "";
  constructor(id?: string) { super("TEXT", id); }
  get characters() { return this._c; }
  set characters(v: string) { if (!loaded.has(`${this.fontName.family}::${this.fontName.style}`)) throw new Error(`Cannot write to node with unloaded font "${this.fontName.family} ${this.fontName.style}"`); this._c = v; }
  getRangeAllFontNames() { return [this.fontName]; }
  async setTextStyleIdAsync(id: string) { const s = styles.get(id); if (!loaded.has(`${s.fontName.family}::${s.fontName.style}`)) throw new Error("unloaded style font"); this.textStyleId = id; this.fontName = s.fontName; }
}

class C extends N {
  constructor(id: string, public name2: string, public defs: Record<string, any>, public texts: string[]) { super("COMPONENT", id); this.name = name2; }
  createInstance() {
    const i: any = new N("INSTANCE");
    i.name = this.name;
    i.mainComponent = this;
    i.componentProperties = Object.fromEntries(Object.entries(this.defs).map(([k, d]) => [k, { type: d.type, value: d.defaultValue }]));
    i.setProperties = (p: Record<string, unknown>) => { for (const k of Object.keys(p)) { if (!(k in i.componentProperties)) throw new Error(`unknown property ${k}`); const lbl = i.children.find((c: any) => c.name === k.split("#")[0]); if (lbl && !loaded.has("Inter::Regular")) throw new Error("font"); i.componentProperties[k].value = p[k]; } };
    i.getMainComponentAsync = async () => this;
    for (const t of this.texts) { const tn = new T(); tn.name = t; i.appendChild(tn); }
    return i;
  }
}

const styles = new Map<string, any>([
  ["S:h1", { id: "S:h1", fontName: { family: "Inter", style: "Bold" } }],
  ["S:body", { id: "S:body", fontName: { family: "Inter", style: "Regular" } }],
  ["S:cap", { id: "S:cap", fontName: { family: "Inter", style: "Regular" } }],
]);

function resetFigma() {
  nodes.clear(); loaded.clear(); seq = 0;
  const page = new N("PAGE", "0:1");
  new C("1:2", "Type=Primary, Size=Medium", { "Label#10:0": { type: "TEXT", defaultValue: "Button" }, "Show icon#10:1": { type: "BOOLEAN", defaultValue: false } }, ["Label"]);
  new C("1:3", "Type=Secondary, Size=Medium", { "Label#10:0": { type: "TEXT", defaultValue: "Button" } }, ["Label"]);
  new C("2:2", "State=Default", { "Label#20:0": { type: "TEXT", defaultValue: "Label" }, "Placeholder#20:1": { type: "TEXT", defaultValue: "" } }, ["Label", "Placeholder"]);
  new C("3:1", "Link", {}, ["Text"]);
  const vars = new Map(fixtureDs().variables.map((v) => [v.id, { id: v.id, name: v.name }]));
  (globalThis as any).figma = {
    mixed: MIXED,
    currentPage: Object.assign(page, { selection: [] }),
    viewport: { scrollAndZoomIntoView() {} },
    commitUndo() {},
    createFrame: () => { const f = new N("FRAME"); f.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; return f; },
    createText: () => new T(),
    createRectangle: () => new N("RECTANGLE"),
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    getStyleByIdAsync: async (id: string) => styles.get(id) ?? null,
    loadFontAsync: async (f: any) => { loaded.add(`${f.family}::${f.style}`); },
    importComponentByKeyAsync: async () => { throw new Error("no library"); },
    variables: {
      getVariableByIdAsync: async (id: string) => vars.get(id) ?? null,
      setBoundVariableForPaint: (p: any, _f: string, v: any) => ({ ...p, boundVariables: { color: { type: "VARIABLE_ALIAS", id: v.id } } }),
    },
  };
  return page;
}

const { executePlan, applyTransformations } = await import("../src/execute.ts");

function compiledLogin(): ResolvedPlan {
  const v = validatePlan(loginPlan);
  assert.ok(v.success);
  const c = compilePlan(fixtureDs(), v.plan);
  assert.deepEqual(c.errors, []);
  return c.plan!;
}

test("executes the login plan into native frames, instances, tokens and styles", async () => {
  const page = resetFigma();
  const report = await executePlan(compiledLogin());
  assert.deepEqual(report.warnings, []);
  assert.equal(page.children.length, 1);
  const screen = page.children[0];
  assert.equal(screen.type, "FRAME");
  assert.equal(screen.layoutMode, "VERTICAL");
  assert.equal(screen.boundVariables.itemSpacing.id, "v2");
  assert.equal(screen.boundVariables.paddingTop.id, "v3");
  assert.equal(screen.fills[0].boundVariables.color.id, "v5");
  assert.equal(screen.width, 390);
  const [h, body, email, pw, btn, link] = screen.children;
  assert.equal(h.characters, "Welcome back");
  assert.equal(h.textStyleId, "S:h1");
  assert.equal(h.layoutSizingHorizontal, "FILL");
  assert.equal(body.fills[0].boundVariables.color.id, "v6");
  assert.equal(email.type, "INSTANCE");
  assert.equal(email.mainComponent.id, "2:2");
  assert.equal(email.componentProperties["Label#20:0"].value, "Email");
  assert.equal(email.layoutSizingHorizontal, "FILL");
  assert.equal(pw.componentProperties["Label#20:0"].value, "Password");
  assert.equal(btn.mainComponent.id, "1:2");
  assert.equal(btn.componentProperties["Label#10:0"].value, "Continue");
  assert.equal(link.mainComponent.id, "3:1");
  assert.equal(link.children[0].characters, "Forgot password?");
  assert.equal(Object.keys(report.nodeIds).length, 7);
});

test("failed execution rolls back everything it created", async () => {
  const page = resetFigma();
  const plan = compiledLogin();
  (plan.roots[0] as any).children[4].componentId = "404:404"; // component deleted since scan
  await assert.rejects(executePlan(plan), (e: any) => e.detail.type === "COMPONENT_NOT_FOUND" && /rolled back/.test(e.detail.message));
  assert.equal(page.children.length, 0);
});

test("transformations are non-destructive and bind tokens", async () => {
  const page = resetFigma();
  const frame = new N("FRAME"); frame.name = "Old"; page.appendChild(frame);
  frame.layoutMode = "VERTICAL"; frame.itemSpacing = 16;
  const fake = new N("FRAME"); fake.name = "Rectangle 5"; frame.appendChild(fake);
  fake.layoutMode = "HORIZONTAL"; fake.fills = [{ type: "SOLID", color: { r: 0.1, g: 0.45, b: 0.9 } }];
  const label = new T(); loaded.add("Inter::Regular"); label.characters = "Continue"; fake.appendChild(label); loaded.clear();
  const snap = { id: frame.id, type: "FRAME", name: "Old", w: 390, h: 400, layout: { mode: "VERTICAL" as const, gap: 16, padding: { top: 0, right: 0, bottom: 0, left: 0 } }, children: [
    { id: fake.id, type: "FRAME", name: "Rectangle 5", w: 342, h: 48, fills: ["#1a73e8"], layout: { mode: "HORIZONTAL" as const }, children: [{ id: label.id, type: "TEXT", name: "t", text: { chars: "Continue", fontSize: 16 } }] },
  ] };
  const a = analyzeDesign(fixtureDs(), snap);
  const report = await applyTransformations(a.transformations);
  assert.deepEqual(report.failed, []);
  assert.equal(frame.boundVariables.itemSpacing.id, "v2");
  assert.equal(frame.children.length, 2);
  const inst = frame.children[0];
  assert.equal(inst.type, "INSTANCE");
  assert.equal(inst.componentProperties["Label#10:0"].value, "Continue");
  assert.equal(fake.visible, false);
  assert.equal(fake.removed, false);
  assert.match(fake.name, /replaced/);
});
