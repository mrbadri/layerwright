import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan, compilePlan, Resolver, retrieve, analyzeDesign, verifyAgainstPlan, type ResolvedFrame, type ResolvedInstance, type NodeSnapshot } from "../src/index.ts";
import { fixtureDs, loginPlan } from "./fixture.ts";

test("semantic roles are inferred", () => {
  const ds = fixtureDs();
  const btn = ds.componentSets.find((s) => s.name === "Button")!;
  assert.ok(btn.semanticHints!.includes("primary-action"));
  assert.ok(btn.semanticHints!.includes("secondary-action"));
  assert.ok(ds.componentSets.find((s) => s.name === "Forms/Input")!.semanticHints!.includes("text-input"));
  assert.ok(ds.components.find((c) => c.name === "Type=Secondary, Size=Medium")!.semanticHints!.includes("secondary-action"));
});

test("invalid plans never pass validation", () => {
  assert.equal(validatePlan({ name: "x", screens: [] }).success, false);
  assert.equal(validatePlan({ name: "x", screens: [{ type: "banana" }] }).success, false);
  assert.equal(validatePlan("{not json").success, false);
  const r = validatePlan({ name: "x", screens: [{ type: "text" }] });
  assert.equal(r.success, false);
  if (!r.success) assert.equal(r.errors[0].type, "INVALID_PLAN");
  assert.equal(validatePlan(loginPlan).success, true);
});

test("login plan compiles to real components and tokens", () => {
  const ds = fixtureDs();
  const v = validatePlan(loginPlan);
  assert.ok(v.success);
  const c = compilePlan(ds, v.plan);
  assert.deepEqual(c.errors, []);
  const screen = c.plan!.roots[0] as ResolvedFrame;
  assert.equal(screen.kind, "frame");
  assert.equal(screen.layout!.gap!.variableId, "v2");
  assert.equal(screen.layout!.padding!.top!.variableId, "v3");
  assert.equal(screen.fill!.variableId, "v5");
  const [h, body, email, pw, btn, link] = screen.children as any[];
  assert.equal(h.textStyleId, "S:h1");
  assert.equal(body.textStyleId, "S:body");
  assert.equal(body.fill.variableId, "v6");
  assert.equal(email.componentId, "2:2");
  assert.deepEqual(email.properties, { "Label#20:0": "Email", "Placeholder#20:1": "you@company.com" });
  assert.equal(email.sizingH, "fill");
  assert.equal(pw.componentId, "2:2");
  assert.equal((btn as ResolvedInstance).componentId, "1:2");
  assert.deepEqual(btn.properties, { "Label#10:0": "Continue" });
  assert.equal(link.kind, "instance"); // DS has a Link component → reused
  assert.equal(link.componentId, "3:1");
  assert.deepEqual(link.textOverrides, { Text: "Forgot password?" });
  assert.ok(c.summary.tokensUsed.includes("spacing/md"));
});

test("variants resolve by name, record, and role", () => {
  const r = new Resolver(fixtureDs());
  const a = r.findComponent({ component: "Button", variant: "Secondary" });
  assert.ok(!("error" in a) && a.def.id === "1:3");
  const b = r.findComponent({ component: "Button", variant: { Type: "Primary", Size: "Small" } });
  assert.ok(!("error" in b) && b.def.id === "1:4");
  const c = r.findComponent({ role: "secondary-action" });
  assert.ok(!("error" in c) && c.def.id === "1:3");
  const d = r.findComponent({ component: "Button", variant: "Huge" });
  assert.ok("error" in d && d.error.type === "INVALID_VARIANT" && d.error.suggestions!.length > 0);
});

test("missing components and tokens produce structured errors, not broken plans", () => {
  const ds = fixtureDs();
  const v = validatePlan({ name: "x", screens: [{ type: "screen", layout: { gap: "spacing/xxl" }, children: [{ type: "component", component: "DatePicker" }, { type: "text", content: "hi", color: "color/nope" }] }] });
  assert.ok(v.success);
  const c = compilePlan(ds, v.plan);
  assert.equal(c.ok, false);
  assert.equal(c.plan, undefined);
  const types = c.errors.map((e) => e.type).sort();
  assert.deepEqual(types, ["COMPONENT_NOT_FOUND", "TOKEN_NOT_FOUND", "TOKEN_NOT_FOUND"]);
});

test("fallback only when explicitly allowed", () => {
  const ds = fixtureDs();
  const v = validatePlan({ name: "x", screens: [{ type: "screen", children: [{ type: "component", component: "DatePicker", allowFallback: true, props: { label: "Date" } }] }] });
  assert.ok(v.success);
  const c = compilePlan(ds, v.plan);
  assert.ok(c.ok);
  const child = (c.plan!.roots[0] as ResolvedFrame).children[0] as ResolvedFrame;
  assert.equal(child.role, "fallback");
  assert.ok(c.warnings.some((w) => w.includes("allowFallback")));
});

test("retrieval returns only relevant items", () => {
  const r = retrieve(fixtureDs(), "password reset flow");
  const names = r.components.map((c) => c.name);
  assert.ok(names.includes("Button"));
  assert.ok(names.includes("Forms/Input"));
  assert.ok(!names.includes("Logo"));
  assert.ok(r.tokens.spacing.some((t) => t.startsWith("spacing/md")));
});

test("analysis proposes DS replacements, tokens, styles and auto layout", () => {
  const ds = fixtureDs();
  const root: NodeSnapshot = {
    id: "9:0", type: "FRAME", name: "Old login", w: 390, h: 600, layout: { mode: "NONE" }, fills: ["#ffffff"],
    children: [
      { id: "9:1", type: "TEXT", name: "Title", x: 24, y: 24, w: 200, h: 34, text: { chars: "Hello", fontSize: 28, font: "Inter Bold" } },
      { id: "9:2", type: "FRAME", name: "Email field", x: 24, y: 74, w: 342, h: 48, strokes: ["#d1d5db"], fills: ["#ffffff"], layout: { mode: "HORIZONTAL", gap: 8, padding: { top: 12, right: 16, bottom: 12, left: 16 } }, children: [{ id: "9:3", type: "TEXT", name: "ph", text: { chars: "Email", fontSize: 16 } }] },
      { id: "9:4", type: "FRAME", name: "Rectangle 5", x: 24, y: 138, w: 342, h: 48, fills: ["#1a73e8"], radius: 12, layout: { mode: "HORIZONTAL", gap: 8, padding: { top: 12, right: 16, bottom: 12, left: 16 } }, children: [{ id: "9:5", type: "TEXT", name: "t", text: { chars: "Continue", fontSize: 16 } }] },
    ],
  };
  const a = analyzeDesign(ds, root);
  const ops = a.transformations.map((t) => `${t.op}:${t.nodeId}`);
  assert.ok(ops.includes("replace_with_instance:9:2"));
  assert.ok(ops.includes("replace_with_instance:9:4"));
  assert.ok(ops.includes("apply_text_style:9:1"));
  assert.ok(ops.includes("bind_fill:9:0"));
  assert.ok(ops.includes("convert_auto_layout:9:0"));
  const btn = a.transformations.find((t) => t.nodeId === "9:4" && t.op === "replace_with_instance") as any;
  assert.equal(btn.componentId, "1:2");
  assert.deepEqual(btn.properties, { "Label#10:0": "Continue" });
  const al = a.transformations.find((t) => t.op === "convert_auto_layout") as any;
  assert.equal(al.direction, "VERTICAL");
  assert.equal(al.gap, 16);
  assert.ok(a.summary.length >= 3);
});

test("verification detects structural mismatches", () => {
  const ds = fixtureDs();
  const v = validatePlan(loginPlan);
  assert.ok(v.success);
  const plan = compilePlan(ds, v.plan).plan!;
  const root = plan.roots[0] as ResolvedFrame;
  const snap: NodeSnapshot = { id: "a", type: "FRAME", name: "Login", layout: { mode: "VERTICAL", gap: 16 }, bound: { itemSpacing: "spacing/md" }, children: [
    { id: "b", type: "TEXT", name: "Welcome back", text: { chars: "Welcome back", styleId: "S:h1" } },
  ] };
  const m = verifyAgainstPlan(root, snap);
  assert.ok(m.some((x) => x.issue === "child count differs"));
  assert.ok(m.some((x) => x.issue === "missing node"));
});
