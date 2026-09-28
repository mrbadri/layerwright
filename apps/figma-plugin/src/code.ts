// Plugin main thread: a deterministic worker that answers bridge requests.
import type { BridgeRequest, BridgeResponse, ResolvedPlan, Transformation } from "@cde/core";
import { scanDesignSystem, snapshot } from "./scan.ts";
import { executePlan, applyTransformations, ExecError } from "./execute.ts";
import { importTree, ensurePages, foundations } from "./import.ts";

figma.showUI(__html__, { width: 240, height: 130, themeColors: true });

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
      return { fileName: figma.root.name, page: figma.currentPage.name, selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type })) };
    case "scanDesignSystem":
      return scanDesignSystem(p);
    case "inspect": {
      const nodes = await resolveTarget(p.target);
      const depth = p.depth ?? (p.target === "page" ? 1 : 6);
      const out = [];
      for (const n of nodes) out.push(await snapshot(n, { depth, maxNodes: p.maxNodes ?? 400 }));
      return { page: figma.currentPage.name, nodes: out };
    }
    case "executePlan":
      return executePlan(p.plan as ResolvedPlan);
    case "applyTransformations":
      return applyTransformations(p.transformations as Transformation[]);
    case "importTree":
      return importTree(p);
    case "foundations":
      return foundations(p);
    case "ensurePages":
      return ensurePages(p.pages as string[]);
    case "select": {
      const nodes = (await Promise.all((p.nodeIds as string[]).map((id) => figma.getNodeByIdAsync(id)))).filter((n): n is SceneNode => !!n && "x" in n);
      figma.currentPage.selection = nodes;
      if (nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
      return { selected: nodes.length };
    }
    default:
      throw new ExecError({ type: "FIGMA_API_ERROR", message: `Unknown method ${(req as any).method}` });
  }
}

const hello = () => ({ type: "hello", fileName: figma.root.name, fileKey: figma.fileKey, page: figma.currentPage.name, user: figma.currentUser?.name });

figma.ui.onmessage = async (msg: any) => {
  if (msg?.type === "ui-ready") { figma.ui.postMessage({ type: "hello", hello: hello() }); return; }
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
