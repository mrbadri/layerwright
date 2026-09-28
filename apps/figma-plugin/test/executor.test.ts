// Executor tests against a strict in-memory mock of the Figma Plugin API.
// The mock enforces the rules that most often break real plugins: fonts must be loaded
// before text writes, FILL needs an auto-layout parent, HUG needs auto-layout/text,
// setProperties rejects unknown keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, validatePlan, analyzeDesign, type ResolvedPlan } from "@cde/core";
import { fixtureDs, loginPlan } from "../../../packages/core/test/fixture.ts";
import { N, T, loaded, resetFigma } from "./figma-mock.ts";

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
