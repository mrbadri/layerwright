// MCP tool surface. Claude reasons; these tools validate, resolve and execute deterministically.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  analyzeDesign, compilePlan, enrichDesignSystem, retrieve, summarize, validatePlan, verifyAgainstPlan,
  type AnalysisResult, type DesignSystem, type ExecutionReport, type NodeSnapshot, type ResolvedPlan, type StructuredError, type TransformReport, type PlanSummary,
} from "@cde/core";
import { BridgeError, type FigmaTransport } from "./bridge.ts";
import { MappingStore, scanCodebase, verifyCodeUsage } from "./code.ts";
import { importHtml } from "./html-import.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
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
  const workdir = resolve(opts.workdir ?? process.env.CDE_WORKDIR ?? process.cwd());
  const home = join(workdir, ".design-engineer");
  const cacheDir = join(home, "cache");
  const mappings = new MappingStore(join(home, "mapping.json"));
  const plans = new Map<string, { plan: ResolvedPlan; summary: PlanSummary; report?: ExecutionReport }>();
  const analyses = new Map<string, AnalysisResult>();
  let ds: DesignSystem | undefined;

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

  const server = new McpServer({ name: "claude-design-engineer", version: "0.1.0" });

  server.registerTool("figma_status", {
    description: "Check whether the Figma bridge plugin is connected, which file/page is open, the current selection, and whether a Design System scan is cached. Cheap; call first.",
    inputSchema: {},
  }, async () => guard(async () => {
    const base = { connected: bridge.connected(), file: bridge.info()?.fileName, designSystemCached: !!loadDs(), designSystemScannedAt: ds?.scannedAt, workdir };
    if (!bridge.connected()) return ok({ ...base, hint: "Open Figma desktop → Plugins → Development → Claude Design Engineer Bridge." });
    const ping = await bridge.request("ping", {}, 10_000);
    return ok({ ...base, ...(ping as object) });
  }));

  server.registerTool("figma_scan_design_system", {
    description: "Scan the open Figma file for components, component sets/variants/properties, variables (+modes), text/paint/effect styles and library components used in the file. Normalizes, infers semantic roles, caches to disk, and returns a COMPACT summary (not the full dump). Use refresh=true after the DS changed.",
    inputSchema: { refresh: z.boolean().optional(), includeLibraries: z.boolean().optional().describe("Include enabled library variable collections (default true)") },
  }, async ({ refresh, includeLibraries }) => guard(async () => {
    if (!refresh && loadDs() && !staleWarning()) return ok({ cached: true, ...summarize(ds!) });
    const raw: any = await bridge.request("scanDesignSystem", { includeLibraries }, 180_000);
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
    description: "Return a compact semantic snapshot (type, name, size, auto layout, fills, bound variables, text style, instance component/variant/props, children) of the selection (default), the current page (top level), or a node id. Instances are not expanded.",
    inputSchema: { target: z.string().optional().describe("'selection' (default) | 'page' | a node id"), depth: z.number().int().min(0).max(12).optional(), maxNodes: z.number().int().min(1).max(2000).optional() },
  }, async ({ target, depth, maxNodes }) => guard(async () => ok(await bridge.request("inspect", { target, depth, maxNodes }))));

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
    const destructive = !!c.plan.target.parentId;
    return ok({ success: true, planId: c.plan.planId, summary: c.summary, warnings: [...c.warnings, ...(staleWarning() ?? [])], requiresApproval: destructive, next: destructive ? "Show the summary to the user; call figma_execute_plan with approved=true only after they agree." : "Show the summary; then call figma_execute_plan (creates new frames only)." });
  }));

  server.registerTool("figma_execute_plan", {
    description: "Execute a previously previewed plan in Figma (native frames, Auto Layout, component instances, variables, styles). One undo step. Rolls back fully on failure. Automatically verifies the result against the plan. Requires approved=true when the plan writes into an existing node.",
    inputSchema: { planId: z.string(), approved: z.boolean().optional() },
  }, async ({ planId, approved }) => guard(async () => {
    const entry = plans.get(planId);
    if (!entry) return fail([{ type: "INVALID_PLAN", message: `Unknown planId ${planId}. Call figma_preview_plan first.` }]);
    if (entry.plan.target.parentId && !approved) return fail([{ type: "NOT_APPROVED", message: "This plan modifies an existing node. Ask the user, then call again with approved=true." }]);
    const report = await bridge.request<ExecutionReport>("executePlan", { plan: entry.plan }, 180_000);
    entry.report = report;
    const mismatches = await verifyPlan(entry.plan, report);
    return ok({ success: true, created: report.createdRootIds, nodeCount: Object.keys(report.nodeIds).length, warnings: report.warnings, verification: { mismatches, passed: mismatches.length === 0 } });
  }));

  const verifyPlan = async (plan: ResolvedPlan, report: ExecutionReport) => {
    const all = [];
    for (let i = 0; i < plan.roots.length; i++) {
      const id = report.createdRootIds[i];
      const snap = id ? ((await bridge.request<{ nodes: NodeSnapshot[] }>("inspect", { target: id, depth: 12, maxNodes: 2000 })).nodes[0]) : undefined;
      all.push(...verifyAgainstPlan(plan.roots[i], snap));
    }
    return all;
  };

  server.registerTool("figma_verify", {
    description: "Re-inspect the nodes created by an executed plan and report structural mismatches against the plan (missing nodes, wrong component/variant, text, layout, unbound tokens). Use after the user edited things or before implementing code.",
    inputSchema: { planId: z.string() },
  }, async ({ planId }) => guard(async () => {
    const e = plans.get(planId);
    if (!e?.report) return fail([{ type: "INVALID_PLAN", message: "Plan not executed in this session." }]);
    const mismatches = await verifyPlan(e.plan, e.report);
    return ok({ passed: mismatches.length === 0, mismatches });
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
      swaps: z.array(z.object({ selector: z.string(), component: z.string(), variants: z.array(z.object({ test: z.string(), variant: z.string() })).optional(), default: z.string().optional() })).optional()
        .describe("Replace matching elements with instances of existing components (variant chosen by rules; content copied as overrides)"),
      actions: z.array(z.object({ click: z.string(), index: z.number().int().min(0).optional(), waitMs: z.number().min(0).max(10000).optional() })).optional().describe("Clicks to perform before capturing (open menus, advance steps)"),
      replace: z.boolean().optional().describe("Remove an existing section with the same name on that page first"),
      components: z.boolean().optional().describe("Turn each imported root into a component. Names like \"Wish card/State=Chosen\" are combined into component sets."),
      only: z.array(z.string()).optional().describe("Keep only screens whose name contains one of these strings"),
      page: z.string().optional().describe("Page to build on (created if missing)"),
      section: z.string().optional().describe("Wrap the screens in a Figma section with this name"),
      gap: z.number().min(0).max(2000).optional(),
      dryRun: z.boolean().optional(),
    },
  }, async ({ file, root, targets, swaps, actions, replace, components, only, page, section, gap, dryRun }) => guard(async () => {
    let screens = await importHtml({ file: resolve(workdir, file), root: root && resolve(workdir, root), targets, swaps, actions });
    if (only?.length) screens = screens.filter((s) => only.some((o) => s.name.includes(o)));
    const list = screens.map((s) => ({ name: s.name, width: Math.round(s.width), height: Math.round(s.height), nodes: s.nodeCount }));
    if (dryRun || !screens.length) return ok({ dryRun: true, screens: list });
    const res = await bridge.request("importTree", { page, section, gap, components, replace, screens: screens.map(({ name, tree }) => ({ name, tree })) }, 300_000);
    return ok({ imported: list, ...(res as object) });
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

  server.registerTool("figma_select", {
    description: "Select and zoom to node ids in Figma (to show the user what was created or will change).",
    inputSchema: { nodeIds: z.array(z.string()).min(1) },
  }, async ({ nodeIds }) => guard(async () => ok(await bridge.request("select", { nodeIds }))));

  server.registerTool("code_scan_components", {
    description: "Scan the codebase (React/Next) for exported UI components, framework/Tailwind/shadcn signals, and suggest Figma↔code mappings by name. Use before implementing a Figma design so existing components are reused.",
    inputSchema: { root: z.string().optional().describe("Project root (default: server working directory)") },
  }, async ({ root }) => guard(async () => ok({ ...scanCodebase(resolve(root ?? workdir), loadDs()), savedMappings: mappings.read() })));

  server.registerTool("code_mapping", {
    description: "Read or upsert the Figma component → code component mapping stored in .design-engineer/mapping.json (commit it to share with the team).",
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
