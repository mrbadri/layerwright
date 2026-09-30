// Plugin main thread: a deterministic worker that answers bridge requests.
import type { BridgeRequest, BridgeResponse, ResolvedPlan, Transformation } from "@cde/core";
import { scanDesignSystem, snapshot } from "./scan.ts";
import { executePlan, applyTransformations, ExecError, pageOf } from "./execute.ts";
import { editNodes, cleanup } from "./edit.ts";
import { importTree, ensurePages, foundations } from "./import.ts";

declare const __BUILD__: string;
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : "dev";

figma.showUI(__html__, { width: 300, height: 480, themeColors: true });

async function resolveTarget(target?: string): Promise<BaseNode[]> {
  if (!target || target === "selection") return [...figma.currentPage.selection];
  if (target === "page") return [figma.currentPage];
  const n = await figma.getNodeByIdAsync(target);
  if (!n) throw new ExecError({ type: "NODE_NOT_FOUND", message: `Node ${target} not found.` });
  return [n];
}

async function handle(req: BridgeRequest): Promise<unknown> {
  const p = (req.params ?? {}) as any;
  switch (req.method) {
    case "ping":
      return { fileName: figma.root.name, page: figma.currentPage.name, pluginBuild: BUILD,
        // Changes seen since this plugin window opened; a scan older than that can't be vouched for.
        dsChangedSinceScan: dsChanged || (typeof p.scannedAt === "string" && p.scannedAt < watchingSince) || undefined, watchingSince, selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type })) };
    case "scanDesignSystem":
      dsChanged = false;
      return scanDesignSystem(p);
    case "inspect": {
      const nodes = await resolveTarget(p.target);
      const depth = p.depth ?? (p.target === "page" ? 1 : 6);
      const out = [];
      for (const n of nodes) out.push(await snapshot(n, { depth, maxNodes: p.maxNodes ?? 400, expandInstances: !!p.expandInstances, svg: !!p.svg }));
      return { page: figma.currentPage.name, nodes: out };
    }
    case "executePlan":
      return executePlan(p.plan as ResolvedPlan, p.meta);
    case "editNodes":
      return editNodes(p);
    case "cleanup":
      return cleanup(p);
    case "applyTransformations":
      return applyTransformations(p.transformations as Transformation[]);
    case "importTree":
      return importTree(p);
    case "foundations":
      return foundations(p);
    case "ensurePages":
      return ensurePages(p.pages as string[]);
    case "exportImage": {
      // A PNG/JPG of one node, capped so a huge frame doesn't produce a huge payload.
      const n = await figma.getNodeByIdAsync(p.nodeId);
      if (!n || !("exportAsync" in n)) throw new ExecError({ type: "NODE_NOT_FOUND", message: `Node ${p.nodeId} not found or can't be exported.` });
      const node = n as SceneNode;
      const longest = Math.max(node.width, node.height, 1);
      const scale = Math.max(0.05, Math.min(p.scale ?? 1, (p.maxDimension ?? 2000) / longest));
      const bytes = await node.exportAsync({ format: p.format === "jpg" ? "JPG" : "PNG", constraint: { type: "SCALE", value: scale } });
      return { base64: figma.base64Encode(bytes), format: p.format === "jpg" ? "jpg" : "png", scale, width: Math.round(node.width * scale), height: Math.round(node.height * scale), name: node.name };
    }
    case "select": {
      // Selection only works on the current page: switch to the page of the first node, select what's on it.
      const all = (await Promise.all((p.nodeIds as string[]).map((id) => figma.getNodeByIdAsync(id)))).filter((n): n is SceneNode => !!n && "x" in n);
      const page = all.length ? pageOf(all[0]) : undefined;
      if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
      const nodes = all.filter((n) => pageOf(n)?.id === figma.currentPage.id);
      figma.currentPage.selection = nodes;
      if (nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
      return { selected: nodes.length, page: figma.currentPage.name, skippedOnOtherPages: all.length - nodes.length || undefined };
    }
    default:
      throw new ExecError({ type: "FIGMA_API_ERROR", message: `Unknown method ${(req as any).method}` });
  }
}

const hello = () => ({ type: "hello", fileName: figma.root.name, fileKey: figma.fileKey, page: figma.currentPage.name, user: figma.currentUser?.name, pluginBuild: BUILD, selection: figma.currentPage.selection.length });

figma.ui.onmessage = async (msg: any) => {
  if (msg?.type === "ui-ready") {
    figma.ui.postMessage({ type: "hello", hello: hello() });
    // Remember the bridge port per user (parallel sessions use different ports).
    const port = await figma.clientStorage.getAsync("bridgePort").catch(() => undefined);
    if (typeof port === "number" && port !== 7331) figma.ui.postMessage({ type: "port", port });
    return;
  }
  if (msg?.type === "set-port" && typeof msg.port === "number") { await figma.clientStorage.setAsync("bridgePort", msg.port); return; }
  if (msg?.type !== "request") return;
  const req = msg.req as BridgeRequest;
  let res: BridgeResponse;
  try {
    res = { id: req.id, ok: true, result: await handle(req) };
  } catch (e) {
    const error = e instanceof ExecError ? e.detail : { type: "FIGMA_API_ERROR" as const, message: (e as Error)?.message ?? String(e) };
    res = { id: req.id, ok: false, error };
  }
  figma.ui.postMessage({ type: "response", res });
};
figma.on("currentpagechange", () => figma.ui.postMessage({ type: "hello", hello: hello() }));
figma.on("selectionchange", () => figma.ui.postMessage({ type: "selection", count: figma.currentPage.selection.length }));

// Watch for Design System changes (components, component sets, styles) so a stale scan can be flagged.
let dsChanged = false;
const watchingSince = new Date().toISOString();
figma.loadAllPagesAsync().then(() => figma.on("documentchange", (e) => {
  if (dsChanged) return;
  for (const c of e.documentChanges) {
    const t = (c as { node?: { type?: string } }).node?.type;
    if (c.type.startsWith("STYLE_") || t === "COMPONENT" || t === "COMPONENT_SET") { dsChanged = true; return; }
  }
})).catch(() => { /* no watch: status just can't tell */ });
