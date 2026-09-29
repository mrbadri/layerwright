// Swap converted buttons/inputs/links for real Design System components when the scanned DS has them.
// Everything that doesn't resolve stays a styled frame, so the import never loses content.
import { Resolver, mappingDoubt, type DesignPlan, type DesignSystem } from "@cde/core";
import type { Hint } from "./convert.ts";

export function applyDesignSystem(plan: DesignPlan, hints: Hint[], ds: DesignSystem): { plan: DesignPlan; mapped: Record<string, number>; skipped: { path: string; label?: string; component: string; reason: string }[] } {
  const r = new Resolver(ds);
  const out = structuredClone(plan) as any;
  const mapped: Record<string, number> = {};
  const skipped: { path: string; label?: string; component: string; reason: string }[] = [];
  // Deepest paths first so replacing a parent never invalidates a child's path.
  for (const h of [...hints].sort((a, b) => b.path.length - a.path.length)) {
    if (h.role === "card") continue; // cards keep their children; a DS card would drop them
    const found = r.findComponent({ role: h.role });
    if ("error" in found) continue;
    const doubt = mappingDoubt(found, h);
    if (doubt) { skipped.push({ path: h.path, label: h.label, component: found.set?.name ?? found.def.name, reason: doubt }); continue; }
    const loc = locate(out, h.path);
    if (!loc) continue;
    const { parent, key, node } = loc;
    const type = h.role.endsWith("input") ? "input" : h.role === "link" ? "link" : "button";
    const props: Record<string, string> = {};
    if (type === "input") { if (h.placeholder) props.placeholder = h.placeholder; if (h.label) props.label = h.label; }
    else if (h.label) props.label = h.label;
    const repl: any = { type, role: h.role, name: node.name, width: node.width, position: node.position };
    if (type === "link") { repl.content = h.label ?? "Link"; delete repl.role; }
    else repl.props = props;
    parent[key] = Object.fromEntries(Object.entries(repl).filter(([, v]) => v !== undefined));
    const name = found.set?.name ?? found.def.name;
    mapped[name] = (mapped[name] ?? 0) + 1;
  }
  return { plan: out, mapped, skipped };
}

function locate(plan: any, path: string): { parent: any; key: string | number; node: any } | undefined {
  const parts = [...path.matchAll(/(\w+)\[(\d+)\]/g)].map((m) => [m[1], +m[2]] as const);
  let parent: any = plan, cur: any = plan, key: string | number = "";
  for (const [k, i] of parts) {
    const arr = cur?.[k];
    if (!Array.isArray(arr) || !arr[i]) return undefined;
    parent = arr; key = i; cur = arr[i];
  }
  return parts.length ? { parent, key, node: cur } : undefined;
}
