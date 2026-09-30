// Component resolution by id/key and duplicate names; explicit typography vs inferred text styles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, enrichDesignSystem, validatePlan, Resolver, type DesignSystem } from "../src/index.ts";
import { fixtureDs } from "./fixture.ts";

/** The fixture plus a second, older "Accordion" set next to the new one (a common accident in real files). */
function dupDs(): DesignSystem {
  const base = fixtureDs();
  const set = (id: string, page: string, states: string[]) => ({
    set: { id, key: `k${id}`, name: "Accordion", remote: false, page, variantIds: states.map((_, i) => `${id}.${i}`),
      properties: [{ key: "State", name: "State", type: "VARIANT" as const, options: states }] },
    comps: states.map((st, i) => ({ id: `${id}.${i}`, key: `k${id}.${i}`, name: `State=${st}`, remote: false, componentSetId: id, variants: { State: st }, textLayers: ["Title"] })),
  });
  const old = set("8:1", "Archive", ["Collapsed", "Expanded"]);
  const neu = set("9:1", "Components", ["Collapsed", "Expanded", "Paused"]);
  return enrichDesignSystem({ ...base, componentSets: [...base.componentSets, old.set, neu.set], components: [...base.components, ...old.comps, ...neu.comps] });
}

test("equal names: the set that has the requested variant wins", () => {
  const r = new Resolver(dupDs());
  const m = r.findComponent({ component: "Accordion", variant: { State: "Paused" } });
  assert.ok(!("error" in m));
  assert.equal(m.set!.id, "9:1");
});

test("equal names that both fit are an AMBIGUOUS_COMPONENT error with candidates, never a silent pick", () => {
  const r = new Resolver(dupDs());
  const m = r.findComponent({ component: "Accordion", variant: "Expanded" });
  assert.ok("error" in m);
  assert.equal(m.error.type, "AMBIGUOUS_COMPONENT");
  assert.deepEqual((m.error.candidates as any[]).map((c) => [c.id, c.page, c.variantCount]), [["8:1", "Archive", 2], ["9:1", "Components", 3]]);
});

test("component by { id } or { key } picks exactly that set (or that variant)", () => {
  const r = new Resolver(dupDs());
  const a = r.findComponent({ component: { id: "8:1" }, variant: "Expanded" });
  assert.ok(!("error" in a) && a.def.id === "8:1.1");
  const b = r.findComponent({ component: { key: "k9:1.2" } });
  assert.ok(!("error" in b) && b.def.id === "9:1.2");
  const v = validatePlan({ name: "p", screens: [{ type: "component", component: { id: "9:1" }, variant: { State: "Paused" } }] });
  assert.ok(v.success);
  const c = compilePlan(dupDs(), v.plan);
  assert.deepEqual(c.errors, []);
  assert.equal((c.plan!.roots[0] as any).componentId, "9:1.2");
});

test("an unscanned library key compiles to an import-by-key instance with late-bound props", () => {
  const v = validatePlan({ name: "p", screens: [{ type: "component", component: { key: "libkey123" }, variant: "Type=Primary", props: { Label: "Go" } }] });
  assert.ok(v.success);
  const c = compilePlan(fixtureDs(), v.plan);
  assert.deepEqual(c.errors, []);
  const inst = c.plan!.roots[0] as any;
  assert.equal(inst.componentKey, "libkey123");
  assert.equal(inst.remote, true);
  assert.deepEqual(inst.lateProps, { Type: "Primary", Label: "Go" });
});

const textOf = (node: object) => {
  const v = validatePlan({ name: "t", screens: [{ type: "screen", children: [node] }] });
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const c = compilePlan(fixtureDs(), v.plan);
  assert.deepEqual(c.errors, []);
  return (c.plan!.roots[0] as any).children[0];
};

test("explicit font fields are never replaced by an inferred text style", () => {
  const t = textOf({ type: "text", content: "Step 3", fontFamily: "Inter", fontSize: 24, weight: "semibold" });
  assert.equal(t.textStyleId, undefined);
  assert.equal(t.fontSize, 24);
  assert.equal(t.fontWeight, "Semi Bold");
});

test("no role and no style means no text style (HTML imports keep their typography)", () => {
  assert.equal(textOf({ type: "text", content: "plain" }).textStyleId, undefined);
});

test("a role picks a DS style; an explicit style plus font fields keeps both; style null opts out", () => {
  assert.equal(textOf({ type: "text", role: "heading", content: "H" }).textStyleId, "S:h1");
  const both = textOf({ type: "text", style: "Heading/H1", fontSize: 32, content: "H" });
  assert.equal(both.textStyleId, "S:h1");
  assert.equal(both.fontSize, 32);
  assert.equal(textOf({ type: "text", role: "heading", style: null, content: "H" }).textStyleId, undefined);
});

test("verification flags sizes far from the plan or the source, hidden layers and missing text overrides", async () => {
  const { verifyAgainstPlan } = await import("../src/index.ts");
  const frame: any = { kind: "frame", path: "screens[0]", name: "Card", role: "frame", width: 480, sizingH: "fixed", layout: { direction: "VERTICAL" }, children: [
    { kind: "instance", path: "screens[0].children[0]", name: "Acc", componentId: "9:1.1", remote: false, componentName: "Accordion / Expanded", properties: {}, textOverrides: { Title: "Evidence" } },
  ] };
  const snap: any = { id: "1", type: "FRAME", name: "Card", w: 480, h: 1162, layout: { mode: "VERTICAL" }, children: [
    { id: "2", type: "INSTANCE", name: "Acc", w: 320, h: 80, instance: { componentId: "9:1.1", overrides: { Badge: ["visible"] } },
      children: [{ id: "3", type: "TEXT", name: "Title", text: { chars: "Title" } }] },
  ] };
  const issues = verifyAgainstPlan(frame, snap, { sources: { "screens[0]": { w: 480, h: 490 } } }).map((m) => m.issue);
  assert.ok(issues.includes("size far from the source's rendered box"));
  assert.ok(issues.includes("layers hidden by an override the plan didn't ask for"));
  assert.ok(issues.includes('text "Title" not overridden'));
  snap.h = 492; snap.children[0].instance.overrides = {}; snap.children[0].children[0].text.chars = "Evidence";
  assert.deepEqual(verifyAgainstPlan(frame, snap, { sources: { "screens[0]": { w: 480, h: 490 } } }), []);
});

test("the scan summary lists component sets that share a name", async () => {
  const { summarize } = await import("../src/index.ts");
  const d = summarize(dupDs()).duplicateNames!;
  assert.deepEqual(d.map((x) => [x.name, x.candidates.map((c) => c.id)]), [["Accordion", ["8:1", "9:1"]]]);
});

test("analyzer: suggestions come in groups; an odd one-off spacing variable isn't suggested on an even scale", async () => {
  const { analyzeDesign, enrichDesignSystem } = await import("../src/index.ts");
  const base = fixtureDs();
  const ds = enrichDesignSystem({ ...base, variables: [...base.variables, { id: "v9", key: "k9", name: "item spacing/9", collection: "Tokens", type: "FLOAT", remote: false, value: 9 }] });
  const snap: any = { id: "1", type: "FRAME", name: "Card", w: 300, h: 200, layout: { mode: "VERTICAL", gap: 9, padding: { top: 16, right: 16, bottom: 16, left: 16 } }, children: [] };
  const r = analyzeDesign(ds, snap);
  assert.ok(!r.transformations.some((t: any) => t.variableName === "item spacing/9"));
  assert.ok(r.transformations.some((t: any) => t.variableName === "spacing/md"));
  assert.deepEqual(r.groups!.map((g) => [g.id, g.label, g.count]), [["g1", "spacing value → spacing token", 4]]);
});

test("sync: an imported button and pill become the DS variants that look like them; Persian text gets the Fa style by size and weight", async () => {
  const { analyzeDesign, enrichDesignSystem } = await import("../src/index.ts");
  const base = fixtureDs();
  const btnProps = [{ key: "Hierarchy", name: "Hierarchy", type: "VARIANT" as const, options: ["Contained", "Pale"] }, { key: "Size", name: "Size", type: "VARIANT" as const, options: ["sm", "md"] },
    { key: "State", name: "State", type: "VARIANT" as const, options: ["Default", "Hover"] }, { key: "Text#1:0", name: "Text", type: "TEXT" as const }];
  const v = (id: string, variants: Record<string, string>, h: number, fill: string, set = "B") => ({ id, key: `k${id}`, name: Object.entries(variants).map(([k, x]) => `${k}=${x}`).join(", "), remote: true, componentSetId: set, variants, dimensions: { width: 120, height: h }, textLayers: ["Text"], look: { fill } });
  const ds = enrichDesignSystem({ ...base,
    componentSets: [
      { id: "B", key: "kB", name: "Button", remote: true, variantIds: [], properties: btnProps, usage: 40 },
      { id: "G", key: "kG", name: "Badge", remote: true, variantIds: [], properties: [{ key: "Color", name: "Color", type: "VARIANT", options: ["Blue", "Success"] }, { key: "Text#2:0", name: "Text", type: "TEXT" }] },
    ],
    components: [
      v("b1", { Hierarchy: "Contained", Size: "md", State: "Default" }, 40, "#7c3aed"), v("b2", { Hierarchy: "Pale", Size: "md", State: "Default" }, 40, "#f4f3ff"),
      v("b3", { Hierarchy: "Contained", Size: "sm", State: "Default" }, 32, "#7c3aed"), v("b4", { Hierarchy: "Contained", Size: "md", State: "Hover" }, 40, "#6d28d9"),
      v("g1", { Color: "Blue" }, 22, "#eff8ff", "G"), v("g2", { Color: "Success" }, 22, "#ecfdf3", "G"),
    ],
    typography: [
      { styleId: "S:fa", name: "Fa Text sm/Bold", fontFamily: "IRANYekanX", fontStyle: "Bold", fontSize: 14 },
      { styleId: "S:en", name: "Text sm/Bold", fontFamily: "Inter", fontStyle: "Bold", fontSize: 14 },
    ] });
  const snap: any = { id: "1", type: "FRAME", name: "Card", w: 700, h: 300, layout: { mode: "VERTICAL" }, children: [
    { id: "2", type: "FRAME", name: "button", w: 140, h: 40, fills: ["#7c3aed"], radius: 8, layout: { mode: "HORIZONTAL" }, children: [{ id: "3", type: "TEXT", name: "t", text: { chars: "نوشتن انگیزه‌نامه", fontSize: 14, font: "Vazirmatn Bold" } }] },
    { id: "4", type: "FRAME", name: "div", w: 70, h: 22, fills: ["#eef6ff"], radius: 11, layout: { mode: "HORIZONTAL" }, children: [{ id: "5", type: "TEXT", name: "t", text: { chars: "در جریان", fontSize: 12, font: "Vazirmatn Medium" } }] },
    { id: "6", type: "TEXT", name: "title", text: { chars: "درخواست ارتقا", fontSize: 14, font: "Vazirmatn Bold" } },
  ] };
  const r = analyzeDesign(ds, snap, { mode: "sync" });
  const rep = r.transformations.filter((t: any) => t.op === "replace_with_instance") as any[];
  assert.deepEqual(rep.map((t) => [t.nodeId, t.componentId]), [["2", "b1"], ["4", "g1"]]);
  assert.equal(Object.values(rep[0].properties)[0], "نوشتن انگیزه‌نامه");
  const ts = r.transformations.find((t: any) => t.op === "apply_text_style" && t.nodeId === "6") as any;
  assert.equal(ts?.styleName, "Fa Text sm/Bold");
  // The default (audit) mode stays strict: a stand-in font gets no style.
  assert.ok(!analyzeDesign(ds, snap).transformations.some((t: any) => t.op === "apply_text_style"));
});

test("copies of one published set (same key) are one choice; a different key is still ambiguous", async () => {
  const { enrichDesignSystem } = await import("../src/index.ts");
  const base = fixtureDs();
  const set = (id: string, key: string, usage: number) => ({ id, key, name: "Badge", remote: true, usage, variantIds: [`${id}.0`], properties: [{ key: "Color", name: "Color", type: "VARIANT" as const, options: ["Blue"] }] });
  const comp = (id: string) => ({ id: `${id}.0`, key: `k${id}`, name: "Color=Blue", remote: true, componentSetId: id, variants: { Color: "Blue" } });
  const same = enrichDesignSystem({ ...base, componentSets: [...base.componentSets, set("1:10", "K", 3), set("1:20", "K", 9), set("1:30", "K", 1)], components: [...base.components, comp("1:10"), comp("1:20"), comp("1:30")] });
  const m = new Resolver(same).findComponent({ component: "Badge", variant: { Color: "Blue" } });
  assert.ok(!("error" in m) && m.set!.id === "1:20", "the most used copy");
  const other = enrichDesignSystem({ ...base, componentSets: [...base.componentSets, set("1:10", "K", 3), set("1:40", "OTHER", 3)], components: [...base.components, comp("1:10"), comp("1:40")] });
  const a = new Resolver(other).findComponent({ component: "Badge", variant: { Color: "Blue" } });
  assert.ok("error" in a && a.error.type === "AMBIGUOUS_COMPONENT");
  assert.equal((a.error.candidates as unknown[]).length, 2);
});
