// MCP tool surface. Claude reasons; these tools validate, resolve and execute deterministically.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  analyzeDesign, compilePlan, emptyDesignSystem, enrichDesignSystem, retrieve, snapshotToPlan, summarize, validatePlan, verifyAgainstPlan,
  type AnalysisResult, type DesignSystem, type ExecutionReport, type NodeSnapshot, type ResolvedPlan, type StructuredError, type TransformReport, type PlanSummary,
} from "@cde/core";
import { BridgeError, type FigmaTransport } from "./bridge.ts";
import { MappingStore, scanCodebase, verifyCodeUsage } from "./code.ts";
import { diffImages, importHtml, renderToPlan, screenshotHtml } from "@cde/html-import";
import { inlineImages } from "./images.ts";
import { PKG_VERSION } from "./meta.ts";

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (errors: StructuredError[], extra: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ success: false, errors, ...extra }) }], isError: true });

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try { return await fn(); } catch (e) {
    if (e instanceof BridgeError) return fail([e.detail]);
    return fail([{ type: "FIGMA_API_ERROR", message: (e as Error).message ?? String(e) }]);
  }
}

export interface ServerOptions { workdir?: string }

export function createServer(bridge: FigmaTransport, opts: ServerOptions = {}) {
  const workdir = resolve(opts.workdir ?? process.env.LAYERWRIGHT_WORKDIR ?? process.cwd());
  const home = join(workdir, ".layerwright");
  const cacheDir = join(home, "cache");
  const mappings = new MappingStore(join(home, "mapping.json"));
  const plans = new Map<string, { plan: ResolvedPlan; summary: PlanSummary; report?: ExecutionReport; sources?: Record<string, { w: number; h?: number }>; webFonts?: Record<string, string[]> }>();
  const analyses = new Map<string, AnalysisResult>();
  let ds: DesignSystem | undefined;
  // Everything this server creates is tagged with the session (and run), so leftovers can be found and cleaned up.
  const session = `s${Date.now().toString(36)}`;
  let runSeq = 0;
  const meta = () => ({ session, run: `${session}.${++runSeq}` });
  let lastPage: string | undefined;

  const cacheFile = (fileName: string) => join(cacheDir, `${fileName.replace(/[^\w.-]+/g, "_")}.json`);
  const loadDs = (): DesignSystem | undefined => {
    if (ds) return ds;
    const name = bridge.info()?.fileName;
    if (name && existsSync(cacheFile(name))) ds = JSON.parse(readFileSync(cacheFile(name), "utf8"));
    return ds;
  };
  const needDs = () => {
    const d = loadDs();
    if (!d) throw new BridgeError({ type: "DESIGN_SYSTEM_NOT_SCANNED", message: "No Design System cached. Call figma_scan_design_system first." });
    return d;
  };
  const staleWarning = () => {
    const f = bridge.info()?.fileName;
    return ds && f && ds.fileName !== f ? [`Cached Design System is from "${ds.fileName}" but Figma has "${f}" open. Rescan if this file has its own components.`] : undefined;
  };

  const server = new McpServer({ name: "layerwright", version: "0.1.0" });

  server.registerTool("figma_status", {
    description: "Check whether the Figma bridge plugin is connected, which file/page is open, the current selection, and whether a Design System scan is cached. Cheap; call first.",
    inputSchema: {},
  }, async () => guard(async () => {
    const base = { connected: bridge.connected(), file: bridge.info()?.fileName, designSystemCached: !!loadDs(), designSystemScannedAt: ds?.scannedAt, workdir };
    if (!bridge.connected()) return ok({ ...base, hint: "Open Figma desktop → Plugins → Development → Layerwright." });
    const ping = await bridge.request<{ page: string; dsChangedSinceScan?: boolean; watchingSince?: string }>("ping", { scannedAt: ds?.scannedAt }, 10_000);
    const warnings = [...(staleWarning() ?? [])];
    if (ds && ping.dsChangedSinceScan) warnings.push("Components or styles changed in Figma since the last scan. Rescan (figma_scan_design_system refresh: true) before planning.");
    if (lastPage && ping.page !== lastPage) warnings.push(`Figma now shows page "${ping.page}", but the last build went to "${lastPage}". Plans build on the current page unless target.page is set.`);
    return ok({ ...base, ...ping, session, warnings: warnings.length ? warnings : undefined });
  }));

  server.registerTool("figma_scan_design_system", {
    description: "Scan the open Figma file for components, component sets/variants/properties, variables (+modes), text/paint/effect styles and library components used in the file. Normalizes, infers semantic roles, caches to disk, and returns a COMPACT summary (not the full dump). Use refresh=true after the DS changed.",
    inputSchema: { refresh: z.boolean().optional(), includeLibraries: z.boolean().optional().describe("Include enabled library variable collections (default true)"),
      reload: z.boolean().optional().describe("Re-read the cache file from disk (after editing it) instead of scanning"),
      maxInstances: z.number().int().min(100).max(200000).optional().describe("How many instances to check for library components (default: 3000, or every instance on the current page)") },
  }, async ({ refresh, includeLibraries, reload, maxInstances }) => guard(async () => {
    if (reload) { ds = undefined; if (!loadDs()) return fail([{ type: "DESIGN_SYSTEM_NOT_SCANNED", message: "No cache file for this Figma file; scan instead." }]); return ok({ cached: true, reloaded: true, ...summarize(ds!) }); }
    if (!refresh && loadDs() && !staleWarning()) return ok({ cached: true, ...summarize(ds!) });
    const raw: any = await bridge.request("scanDesignSystem", { includeLibraries, maxInstances }, 180_000);
    const { warnings, ...rest } = raw;
    ds = enrichDesignSystem(rest);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile(ds.fileName), JSON.stringify(ds));
    return ok({ cached: false, warnings, ...summarize(ds) });
  }));

  server.registerTool("figma_get_design_context", {
    description: "Retrieve ONLY the Design System parts relevant to a task (components with variants/properties, spacing/color/radius tokens, text styles, and known code mappings). Use before writing a Design Plan. Example task: 'password reset flow: email, OTP, new password, success'.",
    inputSchema: { task: z.string(), roles: z.array(z.string()).optional().describe("Extra semantic roles, e.g. ['otp-input','toast']"), limit: z.number().int().min(1).max(40).optional() },
  }, async ({ task, roles, limit }) => guard(async () => {
    const d = needDs();
    const r = retrieve(d, task, { roles, limit });
    const maps = r.components.map((c) => mappings.forComponent(c.name)).filter(Boolean);
    return ok({ ...r, codeMappings: maps, warnings: staleWarning() });
  }));

  server.registerTool("figma_inspect", {
    description: "Read Figma nodes: the selection (default), the current page (top level) or a node id. format: tree (default; compact snapshot of layout, fills, bound variables, text styles, instances), summary (counts, instances per component, top-level children; cheap for big frames), text (every text layer, flat), instances (every instance with variants, props and overrides, flat), plan (the subtree as a Design Plan you can edit and send to figma_preview_plan: clone, refactor, or implement in code). Big answers are capped; use summary, a smaller depth, or offset/limit.",
    inputSchema: { target: z.string().optional().describe("'selection' (default) | 'page' | a node id"), depth: z.number().int().min(0).max(20).optional(), maxNodes: z.number().int().min(1).max(5000).optional(),
      expandInstances: z.boolean().optional().describe("tree: descend into instances (their text, hidden layers, overrides)"),
      format: z.enum(["tree", "summary", "text", "instances", "plan"]).optional(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional().describe("text/instances: page through the list (default 100)") },
  }, async ({ target, depth, maxNodes, expandInstances, format, offset, limit }) => guard(async () => {
    const f = format ?? "tree";
    const deep = f !== "tree";
    const res = await bridge.request<{ page: string; nodes: NodeSnapshot[] }>("inspect", { target, depth: depth ?? (deep ? 20 : undefined), maxNodes: maxNodes ?? (deep ? 5000 : undefined), expandInstances: deep || expandInstances }, 120_000);
    if (!res.nodes.length) return fail([{ type: "NODE_NOT_FOUND", message: "Nothing selected. Pass a node id or ask the user to select a frame." }]);
    const flat: { n: NodeSnapshot; path: string; inInstance: boolean }[] = [];
    const walk = (n: NodeSnapshot, path: string, inInstance: boolean) => { flat.push({ n, path, inInstance }); (n.children ?? []).forEach((c) => walk(c, `${path} / ${c.name}`, inInstance || n.type === "INSTANCE")); };
    res.nodes.forEach((n) => walk(n, n.name, false));
    const page = <T,>(items: T[]) => { const o = offset ?? 0, l = limit ?? 100; return { items: items.slice(o, o + l), total: items.length, offset: o, next: o + l < items.length ? o + l : undefined }; };
    if (f === "summary") {
      const byType: Record<string, number> = {}, byComponent: Record<string, number> = {};
      for (const { n, inInstance } of flat) { if (inInstance) continue; byType[n.type] = (byType[n.type] ?? 0) + 1; if (n.instance) { const k = `${n.instance.componentSet ?? n.instance.component}${n.instance.variants ? ` / ${Object.values(n.instance.variants).join(", ")}` : ""}`; byComponent[k] = (byComponent[k] ?? 0) + 1; } }
      return ok({ page: res.page, roots: res.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, size: `${n.w}×${n.h}`, layout: n.layout?.mode, children: (n.children ?? []).map((c) => ({ id: c.id, type: c.type, name: c.name, size: `${c.w}×${c.h}` })).slice(0, 60) })), byType, instancesByComponent: byComponent, hiddenLayers: flat.filter((x) => x.n.visible === false && !x.inInstance).length });
    }
    if (f === "text") return ok({ page: res.page, ...page(flat.filter((x) => x.n.type === "TEXT").map(({ n, path, inInstance }) => ({ id: n.id, path, text: n.text?.chars, style: n.text?.style ?? n.text?.font, size: n.text?.fontSize, inInstance: inInstance || undefined, hidden: n.visible === false || undefined }))) });
    if (f === "instances") return ok({ page: res.page, ...page(flat.filter((x) => x.n.type === "INSTANCE").map(({ n, path }) => ({ id: n.id, path, componentSet: n.instance?.componentSet, componentSetId: n.instance?.componentSetId, component: n.instance?.component, componentId: n.instance?.componentId, variants: n.instance?.variants, props: n.instance?.props, overrides: n.instance?.overrides }))) });
    if (f === "plan") {
      const out = res.nodes.map((n) => snapshotToPlan(n, loadDs()));
      const plan = { ...out[0].plan, screens: out.flatMap((o) => o.plan.screens) };
      return ok({ plan, warnings: out.flatMap((o) => o.warnings).slice(0, 30), next: "Edit the plan (or reuse it as is), then figma_preview_plan. Instances point at their component set by id." });
    }
    const text = JSON.stringify(res);
    if (text.length > 80_000) return ok({ truncated: true, chars: text.length, hint: "This tree is too big to return whole. Use format: \"summary\" first, then inspect a child by id, lower depth, or format text/instances with offset/limit.", preview: text.slice(0, 20_000) });
    return ok(res);
  }));

  server.registerTool("figma_preview_plan", {
    description: "Validate a Design Plan (Design DSL JSON) with Zod, resolve every component/variant/property/token against the cached Design System, and return a planId + human-readable summary WITHOUT touching Figma. Invalid plans or unresolved components return structured errors with suggestions — fix the plan and preview again.",
    inputSchema: { plan: z.any().describe("DesignPlan object: { name, screens: DesignNode[], target?, screenGap? }. See the figma-design skill for the DSL.") },
  }, async ({ plan }) => guard(async () => {
    const v = validatePlan(plan);
    if (!v.success) return fail(v.errors);
    const d = needDs();
    const c = compilePlan(d, v.plan);
    if (!c.ok || !c.plan) return fail(c.errors, { warnings: c.warnings, summary: c.summary });
    plans.set(c.plan.planId, { plan: c.plan, summary: c.summary });
    const destructive = !!c.plan.target.parentId || !!c.plan.inserts?.length;
    return ok({ success: true, planId: c.plan.planId, summary: c.summary, warnings: [...c.warnings, ...(staleWarning() ?? [])], requiresApproval: destructive, next: destructive ? "Show the summary to the user; call figma_execute_plan with approved=true only after they agree." : "Show the summary; then call figma_execute_plan (creates new frames only)." });
  }));

  server.registerTool("import_html_to_plan", {
    description: "Convert an HTML page or folder (e.g. a Claude Design standalone HTML export) into an editable Design Plan: flexbox → Auto Layout, colors, borders, radii, shadows, gradients, fonts, text (incl. RTL), images and SVG icons. With a scanned Design System, buttons/inputs/links become real DS components. Returns a planId for figma_execute_plan, exactly like figma_preview_plan. Nothing is sent to Figma yet.",
    inputSchema: {
      path: z.string().describe("An .html file, or a folder containing index.html"),
      viewport: z.union([z.number().int().min(200).max(4000), z.array(z.number().int().min(200).max(4000)).min(1).max(6)]).optional().describe("Viewport width(s). Default [1440, 390] (desktop + mobile)"),
      useDesignSystem: z.boolean().optional().describe("Map buttons/inputs/links to scanned DS components (default: true when a DS is cached)"),
      selector: z.string().optional().describe("CSS selector of the element to import (default body)"),
      mappings: z.array(z.object({
        selector: z.string().describe("CSS selector, e.g. .btn-primary"),
        component: z.union([z.string(), z.object({ id: z.string().optional(), key: z.string().optional() }).strict()]),
        variant: z.union([z.string(), z.record(z.string())]).optional(),
        props: z.record(z.union([z.string(), z.boolean()])).optional().describe('Component props; "$text" is the element\'s text (default: { label: "$text" })'),
      })).optional().describe("Your own element → component mappings; they win over automatic Design System matching"),
      fontMap: z.record(z.string()).optional().describe('Replace font families, e.g. { "YekanBakhFaNum": "IRANYekanX" } for a web font that isn\'t installed'),
    },
  }, async ({ path, viewport, useDesignSystem, selector, mappings: userMappings, fontMap }) => guard(async () => {
    const cached = loadDs();
    const useDs = useDesignSystem ?? !!cached;
    if (useDs && !cached) return fail([{ type: "DESIGN_SYSTEM_NOT_SCANNED", message: "useDesignSystem needs a scan. Call figma_scan_design_system, or pass useDesignSystem: false." }]);
    const d = useDs ? cached! : emptyDesignSystem(bridge.info()?.fileName);
    const r = await renderToPlan(resolve(workdir, path), { viewports: viewport === undefined ? undefined : [viewport].flat(), selector, ds: useDs ? d : undefined, mappings: userMappings, fontMap });
    const c = compilePlan(d, r.plan);
    if (!c.ok || !c.plan) return fail(c.errors, { warnings: [...r.warnings, ...c.warnings], summary: c.summary });
    plans.set(c.plan.planId, { plan: c.plan, summary: c.summary, sources: r.sources, webFonts: r.webFonts });
    return ok({ success: true, planId: c.plan.planId, summary: c.summary, mappedToDesignSystem: r.mapped, warnings: [...r.warnings, ...c.warnings].slice(0, 30), next: "Show the summary; then call figma_execute_plan with this planId." });
  }));

  server.registerTool("figma_execute_plan", {
    description: "Execute a previously previewed plan in Figma (native frames, Auto Layout, component instances, variables, styles). One undo step. Rolls back fully on failure. Automatically verifies the result against the plan. Requires approved=true when the plan writes into an existing node.",
    inputSchema: { planId: z.string(), approved: z.boolean().optional() },
  }, async ({ planId, approved }) => guard(async () => {
    const entry = plans.get(planId);
    if (!entry) return fail([{ type: "INVALID_PLAN", message: `Unknown planId ${planId}. Call figma_preview_plan first.` }]);
    if ((entry.plan.target.parentId || entry.plan.inserts?.length) && !approved) return fail([{ type: "NOT_APPROVED", message: "This plan modifies an existing node. Ask the user, then call again with approved=true." }]);
    const images = await inlineImages(entry.plan);
    const m = meta();
    const report = await bridge.request<ExecutionReport>("executePlan", { plan: images.plan, meta: m }, 180_000);
    entry.report = report;
    lastPage = report.page?.name;
    const mismatches = await verifyPlan(entry.plan, report, entry.sources);
    return ok({ success: true, created: report.createdRootIds, page: report.page?.name, run: m.run, nodeCount: Object.keys(report.nodeIds).length, warnings: [...images.warnings, ...explainFonts(report.warnings, entry.webFonts)], verification: verdict(mismatches),
      next: "Check it visually with figma_export_image (pass compareWith: { html } for an HTML import)." });
  }));

  /** Say why a font is missing when the page only ships it as a web font (Figma can't load .woff/.woff2). */
  const explainFonts = (warnings: string[], webFonts: Record<string, string[]> = {}) => warnings.map((w) => {
    const m = w.match(/^Font "([^"]+)" is not (?:available|installed)/);
    const formats = m && Object.entries(webFonts).find(([f]) => f.toLowerCase() === m[1].toLowerCase())?.[1];
    if (!m || !formats) return w;
    const webOnly = formats.length > 0 && formats.every((f) => f === "woff" || f === "woff2");
    return `${w} The page loads it as a web font (${formats.join(", ") || "unknown format"})${webOnly ? ", which Figma can't use: install a TTF/OTF version of it on this machine" : ": install it on this machine"}, or re-import with fontMap: { "${m[1]}": "<an installed family>" }.`;
  });

  const verifyPlan = async (plan: ResolvedPlan, report: ExecutionReport, sources?: Record<string, { w: number; h?: number }>) => {
    const all = [];
    const roots = [...plan.roots, ...(plan.inserts ?? []).flatMap((x) => x.roots)];
    for (let i = 0; i < roots.length; i++) {
      const id = report.createdRootIds[i];
      const snap = id ? ((await bridge.request<{ nodes: NodeSnapshot[] }>("inspect", { target: id, depth: 12, maxNodes: 4000, expandInstances: true })).nodes[0]) : undefined;
      all.push(...verifyAgainstPlan(roots[i], snap, { sources }));
    }
    return all;
  };
  /** Keep the answer small: counts by issue, and the first mismatches. */
  const verdict = (mismatches: Awaited<ReturnType<typeof verifyPlan>>) => {
    const byIssue: Record<string, number> = {};
    for (const m of mismatches) byIssue[m.issue] = (byIssue[m.issue] ?? 0) + 1;
    return { passed: mismatches.length === 0, byIssue, mismatches: mismatches.slice(0, 25), total: mismatches.length };
  };

  server.registerTool("figma_verify", {
    description: "Re-inspect the nodes created by an executed plan and report structural mismatches against the plan (missing nodes, wrong component/variant, text, layout, unbound tokens). Use after the user edited things or before implementing code.",
    inputSchema: { planId: z.string() },
  }, async ({ planId }) => guard(async () => {
    const e = plans.get(planId);
    if (!e?.report) return fail([{ type: "INVALID_PLAN", message: "Plan not executed in this session." }]);
    return ok(verdict(await verifyPlan(e.plan, e.report, e.sources)));
  }));

  server.registerTool("figma_analyze_design", {
    description: "Mode B. Inspect the selected frame (or node id), compare it to the Design System, and propose NON-destructive transformations: custom buttons/inputs → DS instances, raw spacing/radius → tokens, raw colors → color variables, raw text → text styles, manual layout → Auto Layout. Returns an analysisId + grouped summary. Nothing is changed.",
    inputSchema: { target: z.string().optional().describe("'selection' (default) or node id"), verbose: z.boolean().optional().describe("Include every transformation (default: summary + first 40)") },
  }, async ({ target, verbose }) => guard(async () => {
    const d = needDs();
    const snap = await bridge.request<{ nodes: NodeSnapshot[] }>("inspect", { target: target ?? "selection", depth: 20, maxNodes: 20000 });
    if (!snap.nodes.length) return fail([{ type: "NODE_NOT_FOUND", message: "Nothing selected. Ask the user to select a frame." }]);
    const results = snap.nodes.map((n) => analyzeDesign(d, n));
    const merged: AnalysisResult = { analysisId: results.map((r) => r.analysisId).join("_"), transformations: results.flatMap((r) => r.transformations), summary: results.flatMap((r) => r.summary), unresolved: results.flatMap((r) => r.unresolved) };
    analyses.set(merged.analysisId, merged);
    const list = merged.transformations.map((t) => ({ id: t.id, op: t.op, node: t.nodeName, reason: t.reason }));
    return ok({ analysisId: merged.analysisId, summary: merged.summary, transformations: verbose ? list : list.slice(0, 40), total: list.length, unresolved: merged.unresolved.slice(0, 10), next: "Present the summary to the user and ask which to apply. Originals of replaced nodes are hidden, not deleted." });
  }));

  server.registerTool("figma_apply_transformations", {
    description: "Apply transformations from figma_analyze_design. REQUIRES approved=true, which you may only set after the user explicitly approved. Pass ids to apply a subset (default all). Replaced originals are hidden and renamed, never deleted. One undo step.",
    inputSchema: { analysisId: z.string(), approved: z.boolean(), ids: z.array(z.string()).optional(), ops: z.array(z.enum(["bind_fill", "bind_number", "apply_text_style", "convert_auto_layout", "replace_with_instance"])).optional().describe("Apply only these kinds of transformation") },
  }, async ({ analysisId, approved, ids, ops }) => guard(async () => {
    if (!approved) return fail([{ type: "NOT_APPROVED", message: "Get explicit user approval first." }]);
    const a = analyses.get(analysisId);
    if (!a) return fail([{ type: "INVALID_PLAN", message: "Unknown analysisId; run figma_analyze_design again." }]);
    const chosen = a.transformations.filter((t) => (!ids || ids.includes(t.id)) && (!ops || ops.includes(t.op)));
    // Replacements first changes structure; bindings on replaced nodes would be wasted, so drop those.
    const replaced = new Set(chosen.filter((t) => t.op === "replace_with_instance").map((t) => t.nodeId));
    const order = { convert_auto_layout: 0, replace_with_instance: 1, bind_number: 2, bind_fill: 3, apply_text_style: 4 } as const;
    const final = chosen.filter((t) => t.op === "replace_with_instance" || !replaced.has(t.nodeId)).sort((x, y) => order[x.op] - order[y.op]);
    const report = await bridge.request<TransformReport>("applyTransformations", { transformations: final }, 180_000);
    analyses.delete(analysisId);
    const byOp: Record<string, number> = {};
    for (const t of final) if (report.applied.some((a) => a.id === t.id)) byOp[t.op] = (byOp[t.op] ?? 0) + 1;
    return ok({ success: report.failed.length === 0, applied: report.applied.length, byOp, failed: report.failed.slice(0, 20), hiddenOriginals: report.hiddenOriginals.length });
  }));

  server.registerTool("figma_pages", {
    description: "Create (or reorder) pages in the open Figma file, in the given order. Existing pages with the same name are reused; an empty default page is renamed instead of kept.",
    inputSchema: { pages: z.array(z.string().min(1)).min(1).max(40) },
  }, async ({ pages }) => guard(async () => ok(await bridge.request("ensurePages", { pages }, 30_000))));

  server.registerTool("figma_import_html", {
    description: "Import an HTML prototype into Figma at full fidelity for almost no tokens: renders it in headless Chrome, serializes the painted result (boxes, colors, gradients, shadows, radii, text, inline SVG) and builds it on a page. With no targets, every screen on a review board (nested .sc-host) is imported and named by its label. Use dryRun to list screens first.",
    inputSchema: {
      file: z.string().describe("Path to the .html file"),
      root: z.string().optional().describe("Directory to serve (default: the file's grandparent, so ../fonts works)"),
      targets: z.array(z.object({ selector: z.string(), name: z.string().optional(), index: z.number().int().min(0).optional().describe("Take only the nth match") })).optional().describe("CSS selectors of the elements to import as screens"),
      swaps: z.array(z.object({
        selector: z.string(), component: z.string().describe("Component or set name (label for errors when id/key is given)"),
        id: z.string().optional().describe("Exact local component/set id (use when names are ambiguous)"),
        key: z.string().optional().describe("Component/set key, e.g. a library component found by a library search"),
        variants: z.array(z.object({ test: z.string(), variant: z.string() })).optional(), default: z.string().optional(),
        overrides: z.enum(["none", "text", "match"]).optional().describe("none: keep the component as is; text (default): copy matching text; match: also hide layers the element lacks"),
        fills: z.boolean().optional().describe("Copy the element's fill onto the instance (default false)"),
      })).optional()
        .describe("Replace matching elements with instances of existing components. Variant = first rule whose test matches, else default; an unknown variant is an error, never a silent fallback."),
      actions: z.array(z.object({ click: z.string(), index: z.number().int().min(0).optional(), waitMs: z.number().min(0).max(10000).optional() })).optional().describe("Clicks to perform before capturing (open menus, advance steps)"),
      replace: z.boolean().optional().describe("Remove an existing section with the same name on that page first"),
      components: z.boolean().optional().describe("Turn each imported root into a component. Names like \"Wish card/State=Chosen\" are combined into component sets."),
      only: z.array(z.string()).optional().describe("Keep only screens whose name contains one of these strings"),
      page: z.string().optional().describe("Page to build on (created if missing)"),
      section: z.string().optional().describe("Wrap the screens in a Figma section with this name"),
      gap: z.number().min(0).max(2000).optional(),
      fontMap: z.record(z.string()).optional().describe('Replace font families, e.g. { "YekanBakhFaNum": "IRANYekanX" }'),
      dryRun: z.boolean().optional(),
    },
  }, async ({ file, root, targets, swaps, actions, replace, components, only, page, section, gap, fontMap, dryRun }) => guard(async () => {
    let screens = await importHtml({ file: resolve(workdir, file), root: root && resolve(workdir, root), targets, swaps, actions });
    if (fontMap) {
      const fm = new Map(Object.entries(fontMap).map(([k, v]) => [k.toLowerCase(), v]));
      const walk = (n: any) => { if (n.type === "text" && fm.has(n.font.family.toLowerCase())) n.font = { ...n.font, family: fm.get(n.font.family.toLowerCase()) }; (n.children ?? []).forEach(walk); };
      screens.forEach((s) => walk(s.tree));
    }
    if (only?.length) screens = screens.filter((s) => only.some((o) => s.name.includes(o)));
    const list = screens.map((s) => ({ name: s.name, width: Math.round(s.width), height: Math.round(s.height), nodes: s.nodeCount }));
    if (dryRun || !screens.length) return ok({ dryRun: true, screens: list });
    const res = await bridge.request<{ page: string; screens: { id: string; name: string; width: number; height: number }[] }>("importTree", { page, section, gap, components, replace, screens: screens.map(({ name, tree }) => ({ name, tree })), meta: meta() }, 300_000);
    lastPage = res.page;
    // Screens are laid out one per import (component sets combine several), so only compare plain screens.
    const mismatches = components ? [] : res.screens.flatMap((b, i) => {
      const s = list[i];
      return s && (Math.abs(b.width - s.width) > Math.max(4, s.width * 0.05) || Math.abs(b.height - s.height) > Math.max(4, s.height * 0.05))
        ? [{ path: `screens[${i}]`, nodeId: b.id, issue: "size far from the source's rendered box", expected: `${s.width}×${s.height}`, actual: `${Math.round(b.width)}×${Math.round(b.height)}` }] : [];
    });
    return ok({ imported: list, ...res, verification: verdict(mismatches), next: "Check it visually with figma_export_image({ nodeId, compareWith: { html } })." });
  }));

  server.registerTool("figma_foundations", {
    description: "Create or update Design System foundations in the open file: a variable collection (COLOR and FLOAT variables, e.g. \"color/brand/deep-teal\": \"#176B66\", \"radius/media\": 20) and text styles. Idempotent by name. Rescan the DS afterwards.",
    inputSchema: {
      collection: z.string().default("Tokens"),
      colors: z.record(z.string()).optional(),
      numbers: z.record(z.number()).optional(),
      textStyles: z.array(z.object({ name: z.string(), family: z.string(), style: z.string(), size: z.number(), lineHeight: z.number().optional().describe("px"), letterSpacing: z.number().optional().describe("percent") })).optional(),
    },
  }, async (p) => guard(async () => ok(await bridge.request("foundations", p, 60_000))));

  server.registerTool("figma_export_image", {
    description: "Render a Figma node as an image you can look at: use it after every build or edit to check the result visually (empty instances, wrong sizes and wrong variants are obvious in a picture). With compareWith, the source HTML is screenshotted in headless Chrome too, and you get both images, a diff heatmap and the share of changed pixels.",
    inputSchema: {
      nodeId: z.string().describe("Node to render (a frame, section, instance, ...)"),
      scale: z.number().min(0.05).max(4).optional().describe("Default 1; capped so the longest side stays within maxDimension"),
      maxDimension: z.number().int().min(100).max(4000).optional().describe("Default 1600 px"),
      format: z.enum(["png", "jpg"]).optional(),
      compareWith: z.object({
        html: z.string().optional().describe("The .html file (or folder) the node was built from"),
        nodeId: z.string().optional().describe("Another Figma node to compare with (before/after, original/clone)"),
        selector: z.string().optional().describe("Element to screenshot (default body)"),
        viewport: z.number().int().min(200).max(4000).optional().describe("Viewport width (default: the node's width)"),
      }).optional(),
    },
  }, async ({ nodeId, scale, maxDimension, format, compareWith }) => guard(async () => {
    const maxDim = maxDimension ?? 1600;
    const exp = (s?: number) => bridge.request<{ base64: string; format: string; width: number; height: number; scale: number; name: string }>("exportImage", { nodeId, scale: s, format, maxDimension: maxDim }, 120_000);
    const mime = (f: string) => (f === "jpg" ? "image/jpeg" : "image/png");
    if (!compareWith) {
      const img = await exp(scale);
      return { content: [{ type: "image", data: img.base64, mimeType: mime(img.format) }, { type: "text", text: JSON.stringify({ node: img.name, width: img.width, height: img.height, scale: img.scale }) }] };
    }
    if (compareWith.nodeId) {
      const [a, b] = await Promise.all([exp(scale), bridge.request<{ base64: string; format: string; width: number; height: number }>("exportImage", { nodeId: compareWith.nodeId, scale, format, maxDimension: maxDim }, 120_000)]);
      const diff = await diffImages({ base64: a.base64, mime: mime(a.format) }, { base64: b.base64, mime: mime(b.format) });
      const same = diff.changedCells < 0.01 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
      return { content: [
        { type: "text", text: `${nodeId}:` }, { type: "image", data: a.base64, mimeType: mime(a.format) },
        { type: "text", text: `${compareWith.nodeId}:` }, { type: "image", data: b.base64, mimeType: mime(b.format) },
        { type: "text", text: "Diff (red = changed):" }, { type: "image", data: diff.heatmap, mimeType: "image/png" },
        { type: "text", text: JSON.stringify({ a: { width: a.width, height: a.height }, b: { width: b.width, height: b.height }, changedCells: diff.changedCells, regions: diff.regions, verdict: same ? "same" : `${diff.regions.length} changed region(s)` }) },
      ] };
    }
    if (!compareWith.html) return fail([{ type: "INVALID_PLAN", message: "compareWith needs html or nodeId." }]);
    const snap = (await bridge.request<{ nodes: NodeSnapshot[] }>("inspect", { target: nodeId, depth: 0 })).nodes[0];
    const figmaW = snap?.w ?? 1440, figmaH = snap?.h ?? 900;
    const html = await screenshotHtml(resolve(workdir, compareWith.html!), { selector: compareWith.selector, width: compareWith.viewport ?? figmaW });
    // Export at the HTML's pixel size so both images line up (capped by maxDimension).
    const img = await exp(html.width / Math.max(1, figmaW));
    const diff = await diffImages({ base64: html.base64 }, { base64: img.base64, mime: mime(img.format) });
    const sizeOff = Math.abs(figmaW - html.width) > 2 || Math.abs(figmaH - html.height) > Math.max(4, html.height * 0.02);
    const verdict = diff.changedCells < 0.01 && !sizeOff ? "close match"
      : `${sizeOff ? `size differs (Figma ${figmaW}×${figmaH}, HTML ${html.width}×${html.height}); ` : ""}${diff.regions.length} changed region(s), largest first: look at them in the heatmap before reporting success`;
    return { content: [
      { type: "text", text: "Figma:" }, { type: "image", data: img.base64, mimeType: mime(img.format) },
      { type: "text", text: "HTML source:" }, { type: "image", data: html.base64, mimeType: "image/png" },
      { type: "text", text: "Diff (red = changed):" }, { type: "image", data: diff.heatmap, mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ figma: { width: figmaW, height: figmaH }, html: { width: html.width, height: html.height }, changedCells: diff.changedCells, regions: diff.regions, verdict }) },
    ] };
  }));

  const Ref = z.string().describe('Node id, or "$n" for the node made by op n of this call');
  const EditOp = z.discriminatedUnion("op", [
    z.object({ op: z.literal("rename"), node: Ref, name: z.string().min(1) }).strict(),
    z.object({ op: z.literal("move"), node: Ref, parent: Ref.optional(), page: z.string().optional().describe("Page name or id (top level of that page)"), index: z.number().int().min(0).optional(), x: z.number().optional(), y: z.number().optional() }).strict(),
    z.object({ op: z.literal("duplicate"), node: Ref, parent: Ref.optional(), x: z.number().optional(), y: z.number().optional(), name: z.string().optional() }).strict(),
    z.object({ op: z.literal("set"), node: Ref, visible: z.boolean().optional(), locked: z.boolean().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(),
      opacity: z.number().min(0).max(1).optional(), text: z.string().optional().describe("Characters of a text layer"), properties: z.record(z.union([z.string(), z.boolean()])).optional().describe("Instance properties/variants by name") }).strict(),
    z.object({ op: z.literal("delete"), node: Ref }).strict(),
    z.object({ op: z.literal("resizeToFit"), node: Ref.describe("A section, an Auto Layout frame (set to hug) or a frame"), padding: z.number().min(0).optional() }).strict(),
    z.object({ op: z.literal("componentize"), nodes: z.array(Ref).min(1).max(100), mode: z.enum(["single", "multiple", "variants"]).optional(),
      name: z.string().optional().describe("Component (single) or component set (variants) name"),
      variants: z.array(z.record(z.string())).optional().describe('One entry per node, e.g. [{ State: "Expanded", Step: "Evidence" }, …]'),
      duplicate: z.boolean().optional().describe("Work on copies and leave the originals untouched (default true)"),
      exposeText: z.union([z.boolean(), z.array(z.string())]).optional().describe("Turn text layers (all, or these names) into TEXT properties"),
      autoLayout: z.boolean().optional().describe("Give absolutely positioned layers that stack cleanly Auto Layout first, so the component adapts to new text (default true; uneven layouts are left as they are)"),
      parent: Ref.optional(), x: z.number().optional(), y: z.number().optional() }).strict(),
  ]);
  const MUTATES = new Set(["rename", "move", "set", "delete", "resizeToFit"]);

  server.registerTool("figma_edit", {
    description: "Change existing layers in one undo step: rename, move (to a parent, section or page), duplicate, set (visible, position, size, opacity, text, instance properties), delete, resizeToFit (sections grow to their content), and componentize (turn existing frames into a component, several components, or one component set with variants; works on copies by default, and can expose text layers as TEXT properties). Ops run in order and can use \"$n\" for the node made by op n. Changing or deleting existing nodes needs approved=true; without it, delete only hides and renames the node (🗑).",
    inputSchema: { ops: z.array(EditOp).min(1).max(200), approved: z.boolean().optional().describe("Required for ops that change existing nodes; for delete it means really remove") },
  }, async ({ ops, approved }) => guard(async () => {
    const needs = ops.filter((o) => MUTATES.has(o.op) && o.op !== "delete" || (o.op === "componentize" && o.duplicate === false));
    if (needs.length && !approved) return fail([{ type: "NOT_APPROVED", message: `${needs.length} op(s) change existing nodes (${[...new Set(needs.map((o) => o.op))].join(", ")}). Show the user what will change, then call again with approved: true.` }]);
    const res = await bridge.request<{ applied: unknown[]; failed?: { op: number; error: string } }>("editNodes", { ops, approved, meta: meta() }, 180_000);
    return res.failed ? fail([{ type: "FIGMA_API_ERROR", message: `op ${res.failed.op} (${ops[res.failed.op].op}): ${res.failed.error}` }], { ...res }) : ok({ success: true, ...res, next: "Check the result with figma_export_image." });
  }));

  server.registerTool("figma_cleanup", {
    description: "List what Layerwright created (by session, run or node ids) — e.g. leftovers from failed attempts — and, with approved=true, remove it. Default: this session, list only.",
    inputSchema: { scope: z.enum(["session", "all"]).optional().describe("session (default): this server session; all: every Layerwright-made node in the file"),
      run: z.string().optional().describe("Only one run (the `run` returned by figma_execute_plan)"), nodeIds: z.array(z.string()).optional(), approved: z.boolean().optional() },
  }, async ({ scope, run, nodeIds, approved }) => guard(async () => ok(await bridge.request("cleanup", { session: !run && !nodeIds && scope !== "all" ? session : undefined, run, nodeIds, approved }, 120_000))));

  server.registerTool("figma_select", {
    description: "Select and zoom to node ids in Figma (to show the user what was created or will change). Switches to the page of the first node.",
    inputSchema: { nodeIds: z.array(z.string()).min(1) },
  }, async ({ nodeIds }) => guard(async () => ok(await bridge.request("select", { nodeIds }))));

  server.registerTool("code_scan_components", {
    description: "Scan the codebase (React/Next) for exported UI components, framework/Tailwind/shadcn signals, and suggest Figma↔code mappings by name. Use before implementing a Figma design so existing components are reused.",
    inputSchema: { root: z.string().optional().describe("Project root (default: server working directory)") },
  }, async ({ root }) => guard(async () => ok({ ...scanCodebase(resolve(root ?? workdir), loadDs()), savedMappings: mappings.read() })));

  server.registerTool("code_mapping", {
    description: "Read or upsert the Figma component → code component mapping stored in .layerwright/mapping.json (commit it to share with the team).",
    inputSchema: {
      action: z.enum(["get", "set"]),
      mappings: z.array(z.object({ figmaComponent: z.string(), codeComponent: z.string().optional(), importPath: z.string().optional(), props: z.record(z.string()).optional(), variants: z.record(z.string()).optional(), notes: z.string().optional() })).optional(),
    },
  }, async ({ action, mappings: items }) => guard(async () => ok({ mappings: action === "set" ? mappings.upsert(items ?? []) : mappings.read() })));

  server.registerTool("code_verify_usage", {
    description: "Verify an implementation file against the design: are the mapped code components for the plan's Figma components used? Flags raw <button>/<input> duplicates and arbitrary Tailwind values.",
    inputSchema: { file: z.string(), planId: z.string().optional(), figmaComponents: z.array(z.string()).optional() },
  }, async ({ file, planId, figmaComponents }) => guard(async () => {
    const fromPlan = planId ? Object.keys(plans.get(planId)?.summary.instances ?? {}).map((n) => n.split(" / ")[0]) : [];
    return ok(verifyCodeUsage(resolve(workdir, file), [...fromPlan, ...(figmaComponents ?? [])], mappings));
  }));

  return server;
}
