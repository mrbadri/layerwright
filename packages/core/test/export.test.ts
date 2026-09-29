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
