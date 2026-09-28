// HTML → Design DSL snapshot tests (landing page, login form, RTL Persian page), DS mapping, and the
// whole pipeline HTML → plan → compile → execute on the strict Figma mock.
// Snapshots compare numbers with a tolerance of ±2px or ±3% (whichever is larger), so text shaping
// differences between operating systems don't fail the suite. Update with: UPDATE_SNAPSHOTS=1 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePlan, validatePlan } from "@cde/core";
import { fixtureDs } from "../../core/test/fixture.ts";
import { launch, renderToPlan } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f: string) => join(here, "fixtures", f);
const snapDir = join(here, "__snapshots__");

let browserOk = true;
try { await (await launch()).close(); } catch { browserOk = false; }
const maybe = browserOk ? test : test.skip;
if (!browserOk) console.warn("html-import tests skipped: no Chromium (run `npx playwright install chromium`).");

function close(actual: unknown, expected: unknown, path = "$"): string[] {
  if (typeof expected === "number" && typeof actual === "number") return Math.abs(actual - expected) <= Math.max(2, Math.abs(expected) * 0.03) ? [] : [`${path}: ${actual} ≠ ${expected}`];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${path}: array length ${Array.isArray(actual) ? actual.length : typeof actual} ≠ ${expected.length}`];
    return expected.flatMap((e, i) => close(actual[i], e, `${path}[${i}]`));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return [`${path}: ${typeof actual} ≠ object`];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual as object)]);
    return [...keys].flatMap((k) => close((actual as any)[k], (expected as any)[k], `${path}.${k}`));
  }
  return actual === expected ? [] : [`${path}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`];
}

function snapshot(name: string, value: unknown) {
  const file = join(snapDir, `${name}.json`);
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) {
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
    return;
  }
  const diff = close(value, JSON.parse(readFileSync(file, "utf8")));
  assert.deepEqual(diff.slice(0, 20), [], `snapshot ${name} differs`);
}

for (const f of ["landing.html", "login.html", "rtl-fa.html"]) {
  maybe(`snapshot: ${f} → Design DSL (1440 + 390)`, async () => {
    const r = await renderToPlan(fixture(f));
    assert.equal(r.plan.screens.length, 2);
    assert.deepEqual(r.warnings, []);
    snapshot(f.replace(".html", ""), r.plan);
    const c = compilePlan({ ...fixtureDs(), typography: [] }, r.plan);
    assert.deepEqual(c.errors, [], "the imported plan compiles against a Design System");
  });
}

maybe("flexbox becomes Auto Layout; RTL rows keep logical order with direction rtl", async () => {
  const { plan } = await renderToPlan(fixture("rtl-fa.html"), { viewports: [390] });
  const screen: any = plan.screens[0];
  const header = screen.children[0];
  assert.equal(header.layout.direction, "horizontal");
  assert.equal(header.direction, "rtl");
  assert.equal(header.children[0].content, "لیست آرزوهای سارا");
  assert.equal(header.children[0].align, "right");
  const main = screen.children[1];
  assert.equal(main.layout.gap, 12);
  assert.equal(main.layout.crossAlign, "end", "in RTL the column's start edge is the right edge");
});

maybe("buttons, inputs and links map to Design System components when a DS is scanned", async () => {
  const { plan, mapped } = await renderToPlan(fixture("login.html"), { viewports: [390], ds: fixtureDs() });
  const form: any = (plan.screens[0] as any).children[0];
  const email = form.children[1].children[1];
  assert.equal(email.type, "input");
  assert.equal(email.props.placeholder, "you@company.com");
  assert.equal(form.children[2].children[1].role, "password-input");
  assert.equal(form.children[3].type, "button");
  assert.equal(form.children[3].props.label, "Sign in");
  assert.ok(Object.values(mapped).reduce((a, b) => a + b, 0) >= 3);
  const c = compilePlan(fixtureDs(), plan);
  assert.deepEqual(c.errors, []);
  assert.ok(Object.keys(c.summary.instances).some((k) => /Button/.test(k)));
});

maybe("end to end: HTML export → plan → execute on the strict Figma mock → editable frame", async () => {
  const { resetFigma } = await import("../../../apps/figma-plugin/test/figma-mock.ts");
  const { executePlan } = await import("../../../apps/figma-plugin/src/execute.ts");
  const { plan } = await renderToPlan(fixture("landing.html"), { viewports: [1440] });
  const v = validatePlan(plan);
  assert.ok(v.success);
  const c = compilePlan({ ...fixtureDs(), typography: [] }, v.plan);
  assert.deepEqual(c.errors, []);
  const page = resetFigma();
  const report = await executePlan(c.plan!);
  const screen = page.children[0];
  assert.equal(screen.type, "FRAME");
  assert.equal(screen.width, 1440);
  assert.equal(screen.layoutMode, "VERTICAL");
  const nav = screen.children[0];
  assert.equal(nav.layoutMode, "HORIZONTAL");
  assert.equal(nav.primaryAxisAlignItems, "SPACE_BETWEEN");
  const texts = screen.findAllWithCriteria({ types: ["TEXT"] }).map((t: any) => t.characters);
  for (const s of ["Acme", "Ship designs faster", "Get started", "Auto Layout", "Tokens"]) assert.ok(texts.includes(s), `missing text ${s}`);
  // "Vazirmatn" Bold resolves against the mock's installed fonts; nothing fell back silently.
  assert.ok(report.warnings.every((w) => !/could be loaded/.test(w)));
});
