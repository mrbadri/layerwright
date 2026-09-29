// Deterministic, relevant Design System retrieval (no vector DB).
import type { ComponentDefinition, ComponentSetDefinition, DesignSystem } from "./types.ts";
import { norm, tokens } from "./semantics.ts";

/** Task words -> roles likely needed. Keeps retrieval small & relevant. */
const TASK_EXPANSION: Record<string, string[]> = {
  login: ["text-input", "password-input", "primary-action", "secondary-action", "link", "checkbox", "alert", "logo", "divider"],
  "sign in": ["text-input", "password-input", "primary-action", "link", "checkbox", "alert", "logo"],
  signup: ["text-input", "password-input", "primary-action", "link", "checkbox", "alert", "logo"],
  register: ["text-input", "password-input", "primary-action", "link", "checkbox"],
  password: ["text-input", "password-input", "primary-action", "link", "alert", "toast"],
  reset: ["text-input", "primary-action", "link", "alert", "toast"],
  otp: ["otp-input", "text-input", "primary-action", "link", "toast"],
  verification: ["otp-input", "text-input", "primary-action", "link", "toast"],
  form: ["text-input", "select", "checkbox", "radio", "switch", "textarea", "primary-action", "secondary-action", "alert"],
  settings: ["list-item", "switch", "navigation", "divider", "select"],
  profile: ["avatar", "list-item", "navigation", "badge", "primary-action"],
  list: ["list-item", "divider", "empty-state", "loading", "badge"],
  dashboard: ["card", "navigation", "tabs", "badge", "loading"],
  checkout: ["text-input", "primary-action", "card", "divider", "radio", "alert"],
  cart: ["card", "list-item", "primary-action", "badge", "empty-state"],
  product: ["card", "badge", "primary-action", "tabs"],
  search: ["text-input", "list-item", "empty-state", "loading", "badge"],
  modal: ["dialog", "primary-action", "secondary-action"],
  error: ["alert", "error-dialog", "toast", "empty-state"],
  success: ["alert", "toast", "primary-action"],
  empty: ["empty-state", "primary-action"],
  onboarding: ["primary-action", "secondary-action", "link", "tabs"],
  navigation: ["navigation", "tabs", "link"],
};

export interface RetrievedComponent {
  name: string;
  kind: "set" | "component";
  id: string;
  roles: string[];
  description?: string;
  variants?: Record<string, string[]>;
  properties?: { name: string; type: string; default?: unknown; options?: string[] }[];
  size?: string;
  score: number;
}

export interface Retrieval {
  query: string;
  roles: string[];
  components: RetrievedComponent[];
  tokens: { color: string[]; spacing: string[]; radius: string[]; other: string[] };
  textStyles: { name: string; role?: string; spec: string }[];
  mappings?: unknown[];
}

function componentText(c: { name: string; description?: string; semanticHints?: string[] }) {
  return `${norm(c.name)} ${norm(c.description ?? "")} ${(c.semanticHints ?? []).join(" ")}`;
}

export function retrieve(ds: DesignSystem, query: string, opts: { roles?: string[]; limit?: number } = {}): Retrieval {
  const q = norm(query);
  const qTokens = new Set(tokens(query));
  const roles = new Set(opts.roles ?? []);
  for (const [k, rs] of Object.entries(TASK_EXPANSION)) if (q.includes(k)) rs.forEach((r) => roles.add(r));
  // Always useful basics.
  ["primary-action", "button"].forEach((r) => roles.add(r));

  const standalone = ds.components.filter((c) => !c.componentSetId);
  const candidates: (ComponentSetDefinition | ComponentDefinition)[] = [...ds.componentSets, ...standalone];
  const scored = candidates
    .map((c) => {
      const hints = c.semanticHints ?? [];
      let score = 0;
      for (const h of hints) if (roles.has(h)) score += h.includes("-") ? 5 : 3;
      const text = componentText(c);
      for (const t of qTokens) if (t.length > 2 && text.includes(t)) score += 2;
      if (hints.length === 0) score -= 1;
      if (c.remote && score > 0) score += 0.5; // library components are usually the canonical DS
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 15);

  const components: RetrievedComponent[] = scored.map(({ c, score }) => {
    if ("variantIds" in c) {
      const vs = ds.components.filter((v) => v.componentSetId === c.id);
      const variants: Record<string, string[]> = {};
      for (const v of vs) for (const [k, val] of Object.entries(v.variants ?? {})) (variants[k] ??= []).includes(val) || variants[k].push(val);
      const d = vs[0]?.dimensions;
      return {
        name: c.name, kind: "set", id: c.id, roles: c.semanticHints ?? [], description: c.description || undefined, variants,
        properties: c.properties.filter((p) => p.type !== "VARIANT").map((p) => ({ name: p.name, type: p.type, default: p.defaultValue })),
        size: d ? `${Math.round(d.width)}x${Math.round(d.height)}` : undefined, score,
      };
    }
    const d = c.dimensions;
    return {
      name: c.name, kind: "component", id: c.id, roles: c.semanticHints ?? [], description: c.description || undefined,
      properties: (c.properties ?? []).map((p) => ({ name: p.name, type: p.type, default: p.defaultValue })),
      size: d ? `${Math.round(d.width)}x${Math.round(d.height)}` : undefined, score,
    };
  });

  const tk = { color: [] as string[], spacing: [] as string[], radius: [] as string[], other: [] as string[] };
  for (const t of ds.semanticTokens) {
    const label = t.value !== undefined && typeof t.value !== "object" ? `${t.name}=${t.value}` : t.name;
    if (t.category === "color") tk.color.push(label);
    else if (t.category === "spacing") tk.spacing.push(label);
    else if (t.category === "radius") tk.radius.push(label);
  }
  // Keep colors compact: prefer semantic names over raw palette ramps when there are many.
  if (tk.color.length > 60) {
    const semantic = tk.color.filter((c) => /(bg|background|surface|text|fg|foreground|border|primary|secondary|brand|error|danger|success|warning|accent|on )/i.test(c.replace(/[/._-]/g, " ")));
    tk.color = (semantic.length ? semantic : tk.color).slice(0, 60);
  }
  tk.spacing = tk.spacing.slice(0, 30);
  tk.radius = tk.radius.slice(0, 15);

  const textStyles = ds.typography.slice(0, 30).map((t) => ({ name: t.name, role: t.role, spec: `${t.fontFamily} ${t.fontStyle} ${t.fontSize}` }));
  return { query, roles: [...roles], components, tokens: tk, textStyles };
}

/** One-line-per-item summary of the whole DS, for a quick overview without dumping JSON. */
export function summarize(ds: DesignSystem) {
  const roleCounts: Record<string, number> = {};
  for (const s of [...ds.componentSets, ...ds.components.filter((c) => !c.componentSetId)])
    for (const h of s.semanticHints ?? []) roleCounts[h] = (roleCounts[h] ?? 0) + 1;
  return {
    file: ds.fileName,
    scannedAt: ds.scannedAt,
    counts: {
      componentSets: ds.componentSets.length,
      components: ds.components.length,
      remoteComponents: ds.components.filter((c) => c.remote).length,
      variables: ds.variables.length,
      variableCollections: ds.variableCollections.map((c) => `${c.name}${c.remote ? " (library)" : ""} [${c.modes.map((m) => m.name).join(", ")}]`),
      textStyles: ds.typography.length,
      paintStyles: ds.styles.filter((s) => s.type === "PAINT").length,
      effectStyles: ds.styles.filter((s) => s.type === "EFFECT").length,
    },
    roles: roleCounts,
    componentSets: ds.componentSets.slice(0, 80).map((s) => `${s.name} {${s.properties.filter((p) => p.type === "VARIANT").map((p) => `${p.name}: ${(p.options ?? []).join("|")}`).join("; ")}}`),
    standaloneComponents: ds.components.filter((c) => !c.componentSetId).slice(0, 60).map((c) => c.name),
    duplicateNames: duplicateNames(ds),
  };
}

/** Component sets / components that share a name (often an old copy left behind). Plans must pick them by id. */
export function duplicateNames(ds: DesignSystem) {
  const byName = new Map<string, { id: string; page?: string; variants: number; remote: boolean }[]>();
  for (const s of ds.componentSets) byName.set(s.name, [...(byName.get(s.name) ?? []), { id: s.id, page: s.page, variants: s.variantIds.length, remote: s.remote }]);
  for (const c of ds.components.filter((x) => !x.componentSetId)) byName.set(c.name, [...(byName.get(c.name) ?? []), { id: c.id, page: c.page, variants: 0, remote: c.remote }]);
  const dups = [...byName].filter(([, v]) => v.length > 1).map(([name, v]) => ({ name, candidates: v }));
  return dups.length ? dups : undefined;
}
