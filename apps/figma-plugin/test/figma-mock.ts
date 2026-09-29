// Strict in-memory mock of the Figma Plugin API, shared by the executor tests.
// It enforces the rules that most often break real plugins: fonts must be loaded before text
// writes, FILL/ABSOLUTE/minWidth need an auto-layout parent, HUG needs auto-layout or text,
// setProperties rejects unknown keys, only available fonts load, createImage takes PNG/JPEG/GIF bytes.
import { fixtureDs } from "../../../packages/core/test/fixture.ts";

let seq = 0;
export const AVAILABLE_FONTS: { family: string; style: string }[] = [
  ...["Regular", "Medium", "Semi Bold", "Bold", "Italic"].map((style) => ({ family: "Inter", style })),
  ...["Regular", "Medium", "SemiBold", "Bold"].map((style) => ({ family: "Vazirmatn", style })),
];
export const images = new Map<string, Uint8Array>();
export const nodes = new Map<string, any>();
export const loaded = new Set<string>();
const MIXED = Symbol("mixed");

export class N {
  id: string; parent: any = null; children: any[] = []; removed = false; visible = true; name = "";
  x = 0; y = 0; width = 100; height = 100; fills: any[] = []; strokes: any[] = []; boundVariables: any = {};
  layoutMode = "NONE"; itemSpacing = 0; paddingTop = 0; paddingRight = 0; paddingBottom = 0; paddingLeft = 0; cornerRadius = 0;
  private _lh = "FIXED"; private _lv = "FIXED"; private _pos = "AUTO"; private _minW: number | null = null; private _maxW: number | null = null;
  opacity = 1; effects: any[] = []; strokeWeight = 1; strokeAlign = "CENTER"; strokeTopWeight = 1; strokeRightWeight = 1; strokeBottomWeight = 1; strokeLeftWeight = 1; clipsContent = false;
  get layoutPositioning() { return this._pos; }
  set layoutPositioning(v: string) { if (v === "ABSOLUTE" && (!this.parent || this.parent.layoutMode === "NONE")) throw new Error("ABSOLUTE positioning needs an auto-layout parent"); this._pos = v; }
  get minWidth() { return this._minW; }
  set minWidth(v: number | null) { this.checkMinMax(); this._minW = v; }
  get maxWidth() { return this._maxW; }
  set maxWidth(v: number | null) { this.checkMinMax(); this._maxW = v; }
  private checkMinMax() { if (this.layoutMode === "NONE" && (!this.parent || this.parent.layoutMode === "NONE")) throw new Error("min/max width only apply to auto-layout frames and their children"); }
  findAll(fn: (n: any) => boolean): any[] { return this.children.flatMap((c) => [...(fn(c) ? [c] : []), ...(c.findAll ? c.findAll(fn) : [])]); }
  constructor(public type: string, id?: string) { this.id = id ?? `n:${++seq}`; nodes.set(this.id, this); }
  appendChild(c: any) { this.insertChild(this.children.length, c); }
  insertChild(i: number, c: any) { if (c.parent) c.parent.children = c.parent.children.filter((x: any) => x !== c); this.children.splice(i, 0, c); c.parent = this; }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((x: any) => x !== this); }
  resize(w: number, h: number) { this.width = w; this.height = h; }
  setBoundVariable(f: string, v: any) { this.boundVariables[f] = { type: "VARIABLE_ALIAS", id: v.id }; }
  findAllWithCriteria(q: any): any[] {
    if (q.pluginData) return this.findAllWithCriteriaPlugin(q.pluginData.keys);
    return this.children.flatMap((c) => [...(q.types.includes(c.type) ? [c] : []), ...c.findAllWithCriteria(q)]);
  }
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
  locked = false; primaryAxisSizingMode = "AUTO"; counterAxisSizingMode = "AUTO"; layoutWrap = "NO_WRAP"; counterAxisSpacing = 0; dashPattern: number[] = [];
  private data = new Map<string, string>();
  setPluginData(k: string, v: string) { this.data.set(k, v); }
  getPluginData(k: string) { return this.data.get(k) ?? ""; }
  hasPluginData(k: string) { return this.data.has(k); }
  resizeWithoutConstraints(w: number, h: number) { if (this.type !== "SECTION") throw new Error("only sections here"); this.width = w; this.height = h; }
  clone(attach = true): any {
    const c: any = new (this.constructor as any)(...(this.type === "TEXT" ? [] : [this.type]));
    for (const k of ["name", "x", "y", "width", "height", "fills", "strokes", "layoutMode", "itemSpacing", "visible", "cornerRadius"]) c[k] = (this as any)[k];
    if (this.type === "TEXT") { c.fontName = (this as any).fontName; c._c = (this as any)._c; }
    for (const ch of [...this.children]) c.appendChild(ch.clone(false));
    if (attach) this.parent?.appendChild(c);
    return c;
  }
  // Component properties on components and sets.
  componentPropertyDefinitions: Record<string, any> = {};
  addComponentProperty(name: string, type: string, defaultValue: unknown) {
    if (this.type !== "COMPONENT" && this.type !== "COMPONENT_SET") throw new Error("properties need a component or component set");
    const key = `${name}#${++seq}:0`; this.componentPropertyDefinitions[key] = { type, defaultValue }; return key;
  }
  componentPropertyReferences: any = null;
  findAllWithCriteriaPlugin(keys: string[]): any[] { return this.children.flatMap((c) => [...(keys.some((k) => c.hasPluginData(k)) ? [c] : []), ...c.findAllWithCriteriaPlugin(keys)]); }
}

export class T extends N {
  fontName: any = { family: "Inter", style: "Regular" }; fontSize = 12; lineHeight: any = { unit: "AUTO" }; letterSpacing: any = { unit: "PERCENT", value: 0 }; textAutoResize = "NONE"; textAlignHorizontal = "LEFT"; textStyleId = ""; hyperlink: any = null;
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

export function resetFigma() {
  nodes.clear(); loaded.clear(); seq = 0;
  const page = new N("PAGE", "0:1");
  page.name = "Page 1";
  const page2 = new N("PAGE", "0:2");
  page2.name = "Playground";
  const root = new N("DOCUMENT", "0:0");
  root.appendChild(page); root.appendChild(page2);
  new C("1:2", "Type=Primary, Size=Medium", { "Label#10:0": { type: "TEXT", defaultValue: "Button" }, "Show icon#10:1": { type: "BOOLEAN", defaultValue: false } }, ["Label"]);
  new C("1:3", "Type=Secondary, Size=Medium", { "Label#10:0": { type: "TEXT", defaultValue: "Button" } }, ["Label"]);
  new C("2:2", "State=Default", { "Label#20:0": { type: "TEXT", defaultValue: "Label" }, "Placeholder#20:1": { type: "TEXT", defaultValue: "" } }, ["Label", "Placeholder"]);
  new C("3:1", "Link", {}, ["Text"]);
  const vars = new Map(fixtureDs().variables.map((v) => [v.id, { id: v.id, name: v.name }]));
  (globalThis as any).figma = {
    mixed: MIXED,
    currentPage: Object.assign(page, { selection: [] }),
    root,
    loadAllPagesAsync: async () => {},
    setCurrentPageAsync: async (p: any) => { (globalThis as any).figma.currentPage = Object.assign(p, { selection: p.selection ?? [] }); },
    createSection: () => { const s = new N("SECTION"); s.fills = []; return s; },
    createComponentFromNode: (n: any) => {
      if (["COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(n.type)) throw new Error(`cannot create a component from ${n.type}`);
      const c = new N("COMPONENT");
      for (const k of ["name", "x", "y", "width", "height", "fills", "strokes", "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisSizingMode", "counterAxisSizingMode", "cornerRadius"]) (c as any)[k] = n[k];
      for (const ch of [...n.children]) c.appendChild(ch);
      const parent = n.parent; if (parent) parent.insertChild(parent.children.indexOf(n), c); n.remove();
      return c;
    },
    combineAsVariants: (comps: any[], parent: any) => {
      if (!comps.length || comps.some((c) => c.type !== "COMPONENT")) throw new Error("combineAsVariants needs components");
      if (new Set(comps.map((c) => c.name)).size !== comps.length) throw new Error("duplicate variant names");
      const set = new N("COMPONENT_SET"); parent.appendChild(set);
      for (const c of comps) set.appendChild(c);
      return set;
    },
    viewport: { scrollAndZoomIntoView() {} },
    commitUndo() {},
    createFrame: () => { const f = new N("FRAME"); f.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; return f; },
    createText: () => new T(),
    createRectangle: () => new N("RECTANGLE"),
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    getStyleByIdAsync: async (id: string) => styles.get(id) ?? null,
    loadFontAsync: async (f: any) => {
      if (!AVAILABLE_FONTS.some((a) => a.family === f.family && a.style === f.style)) throw new Error(`The font "${f.family} ${f.style}" could not be loaded.`);
      loaded.add(`${f.family}::${f.style}`);
    },
    listAvailableFontsAsync: async () => AVAILABLE_FONTS.map((fontName) => ({ fontName })),
    base64Decode: (s: string) => Uint8Array.from(Buffer.from(s, "base64")),
    createImage: (bytes: Uint8Array) => {
      const png = bytes[0] === 0x89 && bytes[1] === 0x50, jpg = bytes[0] === 0xff && bytes[1] === 0xd8, gif = bytes[0] === 0x47 && bytes[1] === 0x49;
      if (!png && !jpg && !gif) throw new Error("Image type is unsupported");
      const hash = `img:${images.size + 1}`; images.set(hash, bytes); return { hash };
    },
    createNodeFromSvg: (svg: string) => {
      if (!/^\s*<svg[\s>]/.test(svg) || !/<\/svg>\s*$/.test(svg)) throw new Error("Invalid SVG");
      const f = new N("FRAME"); f.fills = [];
      for (const m of svg.matchAll(/<(path|circle|rect)\b([^>]*)>/g)) {
        const v = new N("VECTOR"); v.fills = /fill="none"/.test(m[2]) ? [] : [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
        v.strokes = /stroke="/.test(m[2]) && !/stroke="none"/.test(m[2]) ? [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] : [];
        f.appendChild(v);
      }
      return f;
    },
    importComponentByKeyAsync: async () => { throw new Error("no library"); },
    variables: {
      getVariableByIdAsync: async (id: string) => vars.get(id) ?? null,
      setBoundVariableForPaint: (p: any, _f: string, v: any) => ({ ...p, boundVariables: { color: { type: "VARIABLE_ALIAS", id: v.id } } }),
    },
  };
  return page;
}


