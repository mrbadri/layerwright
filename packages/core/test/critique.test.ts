import { test } from "node:test";
import assert from "node:assert/strict";
import { accessibilityFindings, contrast, designMetrics, type NodeSnapshot } from "../src/index.ts";
import { fixtureDs } from "./fixture.ts";

test("contrast ratio matches WCAG reference values", () => {
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(1), "21.0");
  assert.equal(contrast([118, 118, 118], [255, 255, 255]).toFixed(2), "4.54");
});

test("a11y: low contrast on the real (blended) background, large text threshold, small targets, tiny text", () => {
  const root: NodeSnapshot = { id: "1", type: "FRAME", name: "Card", w: 400, h: 300, fills: ["#FFFFFF"], children: [
    { id: "2", type: "TEXT", name: "hint", fills: ["#A4A7AE"], text: { chars: "Muted hint", fontSize: 14, font: "Inter Regular" } },
    { id: "3", type: "TEXT", name: "title", fills: ["#A4A7AE"], text: { chars: "Big heading", fontSize: 28, font: "Inter Bold" } },
    // White text on a translucent violet over white: blended background decides.
    { id: "4", type: "FRAME", name: "pill", fills: ["#7C3AED33"], w: 80, h: 22, children: [{ id: "5", type: "TEXT", name: "t", fills: ["#FFFFFF"], text: { chars: "New", fontSize: 12, font: "Inter Medium" } }] },
    { id: "6", type: "INSTANCE", name: "Close", w: 16, h: 16, instance: { componentSet: "Button close X" } },
    { id: "7", type: "INSTANCE", name: "Button", w: 120, h: 36, instance: { componentSet: "Button" } },
    { id: "8", type: "TEXT", name: "legal", fills: ["#000000"], text: { chars: "tiny", fontSize: 10, font: "Inter Regular" } },
  ] };
  const f = accessibilityFindings(root);
  const by = (id: string) => f.filter((x) => x.nodeId === id).map((x) => `${x.kind}:${x.severity}`);
  assert.deepEqual(by("2"), ["contrast:error"], "2.4:1 at 14px is far below 4.5:1");
  assert.deepEqual(by("3"), ["contrast:warning"], "large text needs only 3:1, still below");
  assert.deepEqual(by("5"), ["contrast:error"]);
  assert.deepEqual(by("6"), ["target-size:error"]);
  assert.deepEqual(by("7"), ["target-size:info"]);
  assert.deepEqual(by("8"), ["text-size:warning"]);
});

test("critique metrics: spacing off the scale, odd values, near-miss alignment", () => {
  const root: NodeSnapshot = { id: "1", type: "FRAME", name: "Screen", layout: { mode: "VERTICAL", gap: 16, padding: { top: 24, right: 24, bottom: 24, left: 24 } }, children: [
    { id: "2", type: "FRAME", name: "Row", layout: { mode: "HORIZONTAL", gap: 9, padding: { top: 0, right: 0, bottom: 0, left: 0 } }, children: [] },
    { id: "3", type: "FRAME", name: "Free", layout: { mode: "NONE" }, children: [
      { id: "4", type: "TEXT", name: "a", x: 20, y: 0, w: 10, h: 10, text: { chars: "a", fontSize: 14 } }, { id: "5", type: "TEXT", name: "b", x: 22, y: 20, w: 10, h: 10, text: { chars: "b", fontSize: 14 } } ] },
  ] };
  const { metrics, findings } = designMetrics(root, fixtureDs());
  assert.deepEqual(metrics.spacing.offScale, [9]);
  assert.deepEqual(metrics.spacing.notMultipleOf4, [9]);
  assert.equal(metrics.alignment.nearMisses, 1);
  assert.ok(findings.some((x) => x.kind === "alignment"));
});
