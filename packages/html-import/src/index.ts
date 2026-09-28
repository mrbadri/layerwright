// HTML → Figma. Two paths:
//  - renderToPlan: HTML → editable Design DSL (Auto Layout, DS components) → the normal preview/execute pipeline
//  - importHtml:   HTML → pixel-faithful absolute layer tree (figma_import_html)
import { validatePlan, type DesignPlan, type DesignSystem } from "@cde/core";
import { withPage } from "./browser.ts";
import { readDom } from "./dom.ts";
import { toPlan, type Hint } from "./convert.ts";
import { applyDesignSystem } from "./design-system.ts";

export { importHtml, type ImportTarget, type ImportSwap, type ImportAction, type ImportedScreen } from "./tree.ts";
export { toPlan, type Hint, type ConvertResult } from "./convert.ts";
export { applyDesignSystem } from "./design-system.ts";
export { readDom, type DomNode } from "./dom.ts";
export { launch, resolveEntry, withPage } from "./browser.ts";

export interface RenderOptions { viewports?: number[]; selector?: string; root?: string; ds?: DesignSystem; name?: string }
export interface RenderResult { plan: DesignPlan; hints: Hint[]; warnings: string[]; mapped: Record<string, number> }

export const DEFAULT_VIEWPORTS = [1440, 390];

export async function renderToPlan(path: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const viewports = opts.viewports?.length ? opts.viewports : DEFAULT_VIEWPORTS;
  const screens = [];
  let title = "";
  for (const width of viewports) {
    const { dom, t } = await withPage(path, { root: opts.root, width, height: 900 }, async (page) => ({ dom: await readDom(page, opts.selector ?? "body"), t: await page.title() }));
    title ||= t;
    screens.push({ name: `${title || "Page"} – ${width}`, width, dom });
  }
  const converted = toPlan(screens, { name: opts.name ?? (title || "HTML import") });
  let plan = converted.plan;
  let mapped: Record<string, number> = {};
  if (opts.ds) ({ plan, mapped } = applyDesignSystem(plan, converted.hints, opts.ds));
  const v = validatePlan(plan);
  if (!v.success) throw new Error(`Converted plan failed validation: ${v.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  return { plan: v.plan, hints: converted.hints, warnings: converted.warnings, mapped };
}
