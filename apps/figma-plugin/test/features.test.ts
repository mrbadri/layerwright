// DSL v0.2 features through compile → execute on the strict mock: fonts, RTL, images, SVG, effects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, validatePlan } from "@cde/core";
import { fixtureDs } from "../../../packages/core/test/fixture.ts";
import { images, resetFigma } from "./figma-mock.ts";

const { executePlan, closestStyle } = await import("../src/execute.ts");

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function run(screen: object) {
  const v = validatePlan({ name: "t", screens: [screen] });
  assert.ok(v.success, JSON.stringify(!v.success && v.errors));
  const c = compilePlan({ ...fixtureDs(), typography: [] }, v.plan);
  assert.deepEqual(c.errors, []);
  const page = resetFigma();
  const report = await executePlan(c.plan!);
  return { root: page.children[0], report };
}

test("closestStyle matches 'Semi Bold' to 'SemiBold' and falls back by weight", () => {
  assert.equal(closestStyle(["Regular", "SemiBold", "Bold"], "Semi Bold"), "SemiBold");
  assert.equal(closestStyle(["Regular", "Bold"], "Semi Bold"), "Bold");
  assert.equal(closestStyle(["Light", "Regular"], "Medium"), "Regular");
  assert.equal(closestStyle(["Regular", "Italic", "Bold Italic"], "Bold", true), "Bold Italic");
});

test("fonts: Vazirmatn semibold resolves to the real style; a missing family falls back to Inter with a warning", async () => {
  const { root, report } = await run({ type: "screen", children: [
    { type: "text", content: "سلام دنیا", fontFamily: "Vazirmatn", weight: "semibold" },
    { type: "text", content: "Hello", fontFamily: "No Such Font", weight: "bold" },
  ] });
  assert.deepEqual(root.children[0].fontName, { family: "Vazirmatn", style: "SemiBold" });
  assert.deepEqual(root.children[1].fontName, { family: "Inter", style: "Bold" });
  assert.ok(report.warnings.some((w) => /No Such Font/.test(w)));
});

test("RTL: a Persian row is reversed and its text is right-aligned; lineHeight and letterSpacing apply", async () => {
  const { root } = await run({ type: "screen", direction: "rtl", children: [
    { type: "row", children: [
      { type: "text", content: "اول", fontFamily: "Vazirmatn" },
      { type: "text", content: "دوم", fontFamily: "Vazirmatn" },
      { type: "text", content: "سوم", fontFamily: "Vazirmatn" },
    ] },
    { type: "text", content: "متن فارسی", fontFamily: "Vazirmatn", lineHeight: { unit: "px", value: 28 }, letterSpacing: { unit: "percent", value: -1 } },
  ] });
  const row = root.children[0];
  assert.deepEqual(row.children.map((c: any) => c.characters), ["سوم", "دوم", "اول"]);
  assert.equal(row.children[0].textAlignHorizontal, "RIGHT");
  const p = root.children[1];
  assert.deepEqual(p.lineHeight, { unit: "PIXELS", value: 28 });
  assert.deepEqual(p.letterSpacing, { unit: "PERCENT", value: -1 });
});

test("images: data URL becomes an image fill with the fit mode; a bad image keeps the placeholder and warns", async () => {
  const { root, report } = await run({ type: "screen", children: [
    { type: "image", src: PNG_1PX, fit: "crop", width: 100, height: 80 },
    { type: "image", src: "data:image/png;base64,AAAA", width: 100, height: 80 },
  ] });
  const [ok, bad] = root.children;
  assert.equal(ok.fills[0].type, "IMAGE");
  assert.equal(ok.fills[0].scaleMode, "CROP");
  assert.ok(images.has(ok.fills[0].imageHash));
  assert.equal(bad.fills[0].type, "SOLID");
  assert.ok(report.warnings.some((w) => /image could not be loaded/.test(w)));
});

test("icons: inline SVG is created and recolored; invalid SVG draws a placeholder", async () => {
  const { root, report } = await run({ type: "screen", children: [
    { type: "icon", svg: '<svg viewBox="0 0 24 24"><path d="M0 0h24" stroke="#000" fill="none"/></svg>', color: "#176B66", width: 20, height: 20 },
    { type: "icon", svg: "<svg><path", name: "Broken" },
  ] });
  const icon = root.children[0];
  assert.equal(icon.type, "FRAME");
  const vec = icon.children[0];
  assert.equal(vec.fills.length, 0);
  assert.ok(Math.abs(vec.strokes[0].color.g - 0x6b / 255) < 1e-6);
  assert.equal(root.children[1].type, "RECTANGLE");
  assert.ok(report.warnings.some((w) => /invalid SVG/.test(w)));
});

test("styling: shadows, gradient, per-side strokes, opacity, absolute child in auto layout, min/max width", async () => {
  const { root } = await run({ type: "screen", children: [
    { type: "card", name: "Card", opacity: 0.9, stroke: "#E2ECE8", strokeWeights: { top: 1 }, minWidth: 200, maxWidth: 400,
      shadows: [{ x: 0, y: 8, blur: 24, spread: -4, color: "#17252733" }],
      gradient: { angle: 90, stops: [{ color: "#CFECE6", position: 0 }, { color: "#FFFFFF", position: 1 }] },
      children: [{ type: "frame", name: "Badge", width: 28, height: 28, position: { type: "absolute", x: 8, y: 8 } }] },
  ] });
  const card = root.children[0];
  assert.equal(card.opacity, 0.9);
  assert.equal(card.effects[0].type, "DROP_SHADOW");
  assert.equal(card.effects[0].spread, -4);
  assert.equal(card.fills.at(-1).type, "GRADIENT_LINEAR");
  assert.deepEqual([card.strokeTopWeight, card.strokeRightWeight, card.strokeBottomWeight, card.strokeLeftWeight], [1, 0, 0, 0]);
  assert.equal(card.minWidth, 200);
  assert.equal(card.maxWidth, 400);
  const badge = card.children[0];
  assert.equal(badge.layoutPositioning, "ABSOLUTE");
  assert.deepEqual([badge.x, badge.y], [8, 8]);
});

test("DSL rejects bad image sources and non-SVG icon markup at compile time", () => {
  const v = validatePlan({ name: "t", screens: [{ type: "screen", children: [
    { type: "image", src: "file:///etc/passwd" },
    { type: "icon", svg: "<div>not svg</div>" },
  ] }] });
  assert.ok(v.success);
  const c = compilePlan(fixtureDs(), v.plan);
  assert.equal(c.errors.length, 2);
});

test("a root with position absolute inside target.parentId keeps its x/y instead of being placed at 0,0", async () => {
  const page = resetFigma();
  const host: any = (globalThis as any).figma.createFrame();
  page.appendChild(host);
  const v = validatePlan({ name: "t", target: { parentId: host.id }, screens: [
    { type: "frame", name: "Title", width: 200, height: 40 },
    { type: "frame", name: "Badge", width: 40, height: 40, position: { type: "absolute", x: 80, y: 180 } },
  ] });
  assert.ok(v.success);
  const c = compilePlan({ ...fixtureDs(), typography: [] }, v.plan);
  await executePlan(c.plan!);
  const badge = host.children.find((n: any) => n.name === "Badge");
  assert.deepEqual([badge.x, badge.y], [80, 180]);
});
