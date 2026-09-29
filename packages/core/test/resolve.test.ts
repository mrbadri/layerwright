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
