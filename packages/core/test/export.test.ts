// Figma snapshot → Design Plan → compile: an exported subtree is a valid plan that rebuilds the same structure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, snapshotToPlan, validatePlan, type NodeSnapshot, type ResolvedFrame } from "../src/index.ts";
import { fixtureDs } from "./fixture.ts";

const snap: NodeSnapshot = {
  id: "10:1", type: "FRAME", name: "Card", x: 0, y: 0, w: 360, h: 200, fills: ["#ffffff"], radius: 12, bound: { itemSpacing: "spacing/md" },
  layout: { mode: "VERTICAL", gap: 16, padding: { top: 24, right: 24, bottom: 24, left: 24 }, primaryAlign: "MIN", counterAlign: "MIN", sizingH: "FIXED", sizingV: "HUG" },
  children: [
    { id: "10:2", type: "TEXT", name: "Title", w: 120, h: 28, fills: ["#101828"], layout: { mode: "NONE", sizingH: "HUG", sizingV: "HUG" },
      text: { chars: "Welcome back", fontSize: 28, font: "Inter Bold", styleId: "S:h1", style: "Heading/H1", autoResize: "WIDTH_AND_HEIGHT" } },
    { id: "10:3", type: "TEXT", name: "Body", w: 312, h: 40, fills: ["#6b7280"], layout: { mode: "NONE", sizingH: "FILL", sizingV: "HUG" },
      text: { chars: "Sign in to continue", fontSize: 15, font: "Plus Jakarta Sans Semi Bold", lineHeight: 20, autoResize: "HEIGHT" } },
    { id: "10:4", type: "INSTANCE", name: "Button", w: 312, h: 44, layout: { mode: "HORIZONTAL", sizingH: "FILL", sizingV: "HUG" },
      instance: { componentId: "1:3", componentSetId: "1:1", componentSet: "Button", variants: { Type: "Secondary", Size: "Medium" }, props: { "Label#10:0": "Continue" }, overrides: { Label: ["characters"] } },
      children: [{ id: "I10:4;1", type: "TEXT", name: "Label", text: { chars: "Continue" } }] },
    { id: "10:5", type: "VECTOR", name: "Sparkle" },
  ],
};

test("an inspected subtree exports to a valid plan: layout, tokens, text styles, fonts, instances with variants and props", () => {
  const { plan, warnings } = snapshotToPlan(snap, fixtureDs());
  const v = validatePlan(plan);
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const card: any = plan.screens[0];
  assert.deepEqual([card.layout.direction, card.layout.gap, card.layout.padding, card.width, card.height, card.fill, card.radius], ["vertical", "spacing/md", 24, 360, "hug", "#FFFFFF", 12]);
  const [title, body, button] = card.children;
  assert.deepEqual([title.style, title.width], ["Heading/H1", "hug"]);
  assert.deepEqual([body.fontFamily, body.weight, body.fontSize, body.lineHeight, body.width], ["Plus Jakarta Sans", "semibold", 15, { unit: "px", value: 20 }, "fill"]);
  assert.deepEqual([button.component, button.variant, button.props, button.width], [{ id: "1:1" }, { Type: "Secondary", Size: "Medium" }, { Label: "Continue" }, "fill"]);
  assert.ok(warnings.some((w) => /vector "Sparkle"/.test(w)));

  const c = compilePlan(fixtureDs(), v.plan);
  assert.deepEqual(c.errors, []);
  const root = c.plan!.roots[0] as ResolvedFrame;
  assert.equal(root.layout!.gap!.variableId, "v2");
  assert.equal((root.children[0] as any).textStyleId, "S:h1");
  assert.equal((root.children[2] as any).componentId, "1:3", "the same variant");
  assert.deepEqual((root.children[2] as any).properties, { "Label#10:0": "Continue" });
});

test("ellipses, lines, polygons and stars export as shapes (arc, points, strokes) and compile back to the same kinds", () => {
  const s: NodeSnapshot = { id: "20:1", type: "FRAME", name: "Shapes", w: 200, h: 100, layout: { mode: "VERTICAL", sizingH: "FIXED", sizingV: "HUG" }, children: [
    { id: "20:2", type: "ELLIPSE", name: "Ring", w: 40, h: 40, fills: ["#176b66"], shape: { arc: { start: -90, end: 180, innerRadius: 0.8 } } },
    { id: "20:3", type: "LINE", name: "Rule", w: 200, h: 0, strokes: ["#e5e7eb"], strokeWeight: 2, layout: { mode: "NONE", sizingH: "FILL", sizingV: "FIXED" } },
    { id: "20:4", type: "STAR", name: "Star", w: 24, h: 24, fills: ["#f59e0b"], shape: { pointCount: 5, innerRadius: 0.382 } },
  ] };
  const { plan } = snapshotToPlan(s);
  const [ring, rule, star] = (plan.screens[0] as any).children;
  assert.deepEqual([ring.type, ring.shape, ring.arc, ring.fill], ["shape", "ellipse", { start: -90, end: 180, innerRadius: 0.8 }, "#176B66"]);
  assert.deepEqual([rule.shape, rule.width, rule.stroke, rule.strokeWeight, rule.height], ["line", "fill", "#E5E7EB", 2, undefined]);
  assert.deepEqual([star.shape, star.pointCount, star.innerRadius], ["star", 5, 0.382]);
  const v = validatePlan(plan);
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const c = compilePlan(fixtureDs(), v.plan);
  assert.deepEqual(c.errors, []);
  assert.deepEqual((c.plan!.roots[0] as ResolvedFrame).children.map((x: any) => x.shape), ["ellipse", "line", "star"]);
});
