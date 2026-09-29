// figma_edit ops, componentize, real sections and page targeting, on the strict mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePlan, validatePlan, emptyDesignSystem } from "@cde/core";
import { resetFigma, loaded } from "./figma-mock.ts";

const { editNodes, cleanup } = await import("../src/edit.ts");
const { executePlan } = await import("../src/execute.ts");
const F = () => (globalThis as any).figma;

/** A page with a board frame holding `n` accordion-like frames (title text inside). */
function board(n: number) {
  const page = resetFigma();
  loaded.add("Inter::Regular");
  const b = F().createFrame(); b.name = "Board"; b.layoutMode = "VERTICAL"; page.appendChild(b);
  const items = Array.from({ length: n }, (_, i) => {
    const f = F().createFrame(); f.name = `Accordion ${i + 1}`; f.width = 320; f.height = 60; b.appendChild(f);
    const t = F().createText(); t.name = "Title"; t.characters = `Step ${i + 1}`; f.appendChild(t);
    return f;
  });
  return { page, board: b, items };
}

test("componentize → variants works on copies next to the board, and exposes text as a property", async () => {
  const { page, board: b, items } = board(3);
  const r = await editNodes({ ops: [{ op: "componentize", nodes: items.map((i) => i.id), name: "Accordion", exposeText: ["Title"],
    variants: [{ State: "Collapsed", Step: "Evidence" }, { State: "Expanded", Step: "Evidence" }, { State: "Paused", Step: "Final" }] }], meta: { session: "s1", run: "s1.1" } });
  assert.equal(r.failed, undefined);
  const set = page.children.find((c: any) => c.type === "COMPONENT_SET");
  assert.ok(set, "set is on the page, not inside the Auto Layout board");
  assert.equal(set.name, "Accordion");
  assert.deepEqual(set.children.map((c: any) => c.name), ["State=Collapsed, Step=Evidence", "State=Expanded, Step=Evidence", "State=Paused, Step=Final"]);
  assert.ok(set.x >= b.x + b.width, "placed to the right of the originals");
  assert.equal(b.children.length, 3, "originals untouched");
  assert.ok(b.children.every((c: any) => c.type === "FRAME"));
  const key = Object.keys(set.componentPropertyDefinitions)[0];
  assert.match(key, /^Title#/);
  assert.ok(set.children.every((c: any) => c.children[0].componentPropertyReferences.characters === key));
  assert.equal(JSON.parse(set.getPluginData("layerwright")).session, "s1");
});

test("componentize rejects duplicate variant combinations before changing anything", async () => {
  const { page, items } = board(2);
  const r = await editNodes({ ops: [{ op: "componentize", nodes: items.map((i) => i.id), variants: [{ State: "A" }, { State: "A" }] }] });
  assert.match(r.failed!.error, /both be the variant/);
  assert.ok(!page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] }).length);
});

test("rename, duplicate with $ref, move to another page, set text, soft delete without approval", async () => {
  const { items } = board(2);
  const r = await editNodes({ ops: [
    { op: "rename", node: items[0].id, name: "Old Accordion" },
    { op: "duplicate", node: items[1].id, name: "Copy" },
    { op: "move", node: "$1", page: "Playground", x: 10, y: 20 },
    { op: "set", node: items[1].children[0].id, text: "Renamed step" },
    { op: "delete", node: items[0].id },
  ] });
  assert.equal(r.failed, undefined);
  assert.equal(items[1].children[0].characters, "Renamed step");
  const copy = F().root.children[1].children[0];
  assert.deepEqual([copy.name, copy.x, copy.y], ["Copy", 10, 20]);
  assert.equal(items[0].visible, false);
  assert.equal(items[0].name, "🗑 Old Accordion");
  assert.equal(items[0].removed, false);
});

test("a top-level section is a real SectionNode sized to its screens; adding to it later grows it", async () => {
  resetFigma();
  const plan = (p: object) => { const v = validatePlan(p); assert.ok(v.success, JSON.stringify(!v.success && v.errors)); const c = compilePlan(emptyDesignSystem(), v.plan); assert.deepEqual(c.errors, []); return c.plan!; };
  const r = await executePlan(plan({ name: "s", screens: [{ type: "section", name: "Flow", children: [{ type: "screen", name: "A", height: 400 }, { type: "screen", name: "B", height: 400 }] }] }));
  const section = F().currentPage.children[0];
  assert.equal(section.type, "SECTION");
  assert.deepEqual(section.children.map((c: any) => [c.name, c.x, c.y]), [["A", 80, 80], ["B", 550, 80]]);
  assert.deepEqual([section.width, section.height], [1020, 560]);
  await executePlan(plan({ name: "more", target: { parentId: r.createdRootIds[0], x: 1100, y: 80 }, screens: [{ type: "screen", name: "C", height: 900 }] }));
  assert.deepEqual([section.width, section.height], [1570, 1060]);
});

test("target.page builds on that page and switches to it", async () => {
  resetFigma();
  const v = validatePlan({ name: "p", target: { page: "Playground" }, screens: [{ type: "screen", name: "Here" }] });
  assert.ok(v.success);
  const r = await executePlan(compilePlan(emptyDesignSystem(), v.plan).plan!);
  assert.equal(r.page!.name, "Playground");
  assert.equal(F().root.children[1].children[0].name, "Here");
  assert.equal(F().root.children[0].children.length, 0);
});

test("cleanup lists a session's nodes and removes them only with approval", async () => {
  const { items } = board(1);
  await editNodes({ ops: [{ op: "duplicate", node: items[0].id }], meta: { session: "s9", run: "s9.1" } });
  const listed = await cleanup({ session: "s9" });
  assert.equal(listed.nodes.length, 1);
  assert.equal(listed.removed, false);
  const gone = await cleanup({ session: "s9", approved: true });
  assert.equal(gone.removed, true);
  assert.equal((await cleanup({ session: "s9" })).nodes.length, 0);
});

test("componentize gives cleanly stacked absolute layers Auto Layout; text fills the column, uneven layouts stay", async () => {
  const page = resetFigma();
  loaded.add("Inter::Regular");
  const mk = (ys: number[]) => {
    const f = F().createFrame(); f.width = 354; f.height = 120; page.appendChild(f);
    for (const [i, y] of ys.entries()) { const t = F().createText(); t.name = `T${i}`; t.characters = "x"; t.x = 17; t.y = y; t.width = 100; t.height = 18; f.appendChild(t); }
    return f;
  };
  const even = mk([17, 43, 69]), uneven = mk([17, 43, 90]);
  await editNodes({ ops: [{ op: "componentize", nodes: [even.id, uneven.id], mode: "multiple" }] });
  const [a, b] = page.children.filter((c: any) => c.type === "COMPONENT");
  assert.equal(a.layoutMode, "VERTICAL");
  assert.deepEqual([a.itemSpacing, a.paddingTop, a.paddingLeft, a.paddingRight], [8, 17, 17, 17], "right padding mirrors the left one");
  assert.ok(a.children.every((t: any) => t.textAutoResize === "HEIGHT" && t.layoutSizingHorizontal === "FILL"), "text in a column wraps inside it");
  assert.equal(b.layoutMode, "NONE", "uneven gaps keep their exact positions");
});
