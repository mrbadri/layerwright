// Semantic inference over a raw scan: component roles, token categories, typography roles.
import type { ComponentDefinition, ComponentSetDefinition, DesignSystem, SemanticToken, TypographyDefinition, VariableDefinition, StyleDefinition } from "./types.ts";

export const norm = (s: string) =>
  s.toLowerCase().replace(/#[\d:;]+$/, "").replace(/[\s_\-./\\|]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();

export const tokens = (s: string) => norm(s).split(" ").filter(Boolean);

/** Base role keywords. Order matters: first match wins for the "primary" role. Includes a few Persian terms. */
const ROLE_RULES: { role: string; words: RegExp }[] = [
  { role: "button", words: /(?:^| )(button|btn|cta|دکمه)(?= |$)/ },
  { role: "icon-button", words: /(?:^| )(icon ?button|iconbutton|fab)(?= |$)/ },
  { role: "text-input", words: /(?:^| )(input|text ?field|textfield|textbox|field|ورودی)(?= |$)/ },
  { role: "textarea", words: /(?:^| )(textarea|text area|multiline)(?= |$)/ },
  { role: "select", words: /(?:^| )(select|dropdown|combobox|picker)(?= |$)/ },
  { role: "checkbox", words: /(?:^| )(checkbox|check box)(?= |$)/ },
  { role: "radio", words: /(?:^| )(radio)(?= |$)/ },
  { role: "switch", words: /(?:^| )(switch|toggle)(?= |$)/ },
  { role: "otp-input", words: /(?:^| )(otp|pin ?code|verification ?code|code ?input)(?= |$)/ },
  { role: "dialog", words: /(?:^| )(modal|dialog|popup|sheet|bottom ?sheet)(?= |$)/ },
  { role: "toast", words: /(?:^| )(toast|snackbar|notification)(?= |$)/ },
  { role: "alert", words: /(?:^| )(alert|banner|callout|inline ?message)(?= |$)/ },
  { role: "card", words: /(?:^| )(card|tile|panel)(?= |$)/ },
  { role: "link", words: /(?:^| )(link|anchor|hyperlink)(?= |$)/ },
  { role: "navigation", words: /(?:^| )(nav|navbar|navigation|header|app ?bar|top ?bar|tab ?bar|toolbar|breadcrumb|sidebar)(?= |$)/ },
  { role: "tabs", words: /(?:^| )(tabs?|segmented)(?= |$)/ },
  { role: "avatar", words: /(?:^| )(avatar)(?= |$)/ },
  { role: "badge", words: /(?:^| )(badge|tag|chip|pill|label ?tag)(?= |$)/ },
  { role: "divider", words: /(?:^| )(divider|separator|hr)(?= |$)/ },
  { role: "list-item", words: /(?:^| )(list ?item|cell|row item|menu ?item)(?= |$)/ },
  { role: "loading", words: /(?:^| )(spinner|loader|loading|progress|skeleton)(?= |$)/ },
  { role: "icon", words: /(?:^| )(icon|icons|glyph)(?= |$)/ },
  { role: "logo", words: /(?:^| )(logo|brand ?mark)(?= |$)/ },
  { role: "form", words: /(?:^| )(form)(?= |$)/ },
  { role: "empty-state", words: /(?:^| )(empty ?state|empty)(?= |$)/ },
];

const EMPHASIS: { hint: string; words: RegExp }[] = [
  { hint: "primary", words: /(?:^| )(primary|main|filled|solid|brand|default ?primary)(?= |$)/ },
  { hint: "secondary", words: /(?:^| )(secondary|outline|outlined|ghost|tertiary|subtle|text)(?= |$)/ },
  { hint: "destructive", words: /(?:^| )(destructive|danger|error|critical|negative)(?= |$)/ },
  { hint: "success", words: /(?:^| )(success|positive)(?= |$)/ },
  { hint: "warning", words: /(?:^| )(warning|caution)(?= |$)/ },
  { hint: "password", words: /(?:^| )(password|secure)(?= |$)/ },
  { hint: "disabled", words: /(?:^| )(disabled|inactive)(?= |$)/ },
];

export function inferRoles(name: string, description = "", variantValues: string[] = [], dims?: { width: number; height: number }, textLayers: string[] = []): string[] {
  // "_Tab button base", ".Icon/check": private building blocks, never picked by role (only by explicit name).
  if (/^[_.]/.test(name.trim())) return [];
  const hay = norm(`${name} ${description}`);
  const vhay = norm(variantValues.join(" "));
  const roles = new Set<string>();
  for (const r of ROLE_RULES) if (r.words.test(hay)) roles.add(r.role);
  if (roles.has("icon-button")) roles.delete("icon");
  // Structural guess: small component with one text layer and nothing else recognised -> action.
  if (roles.size === 0 && dims && dims.height >= 28 && dims.height <= 64 && dims.width <= 400 && textLayers.length === 1) roles.add("button?");
  const emph = new Set<string>();
  for (const e of EMPHASIS) if (e.words.test(`${hay} ${vhay}`)) emph.add(e.hint);
  const out = [...roles];
  if (roles.has("button")) {
    if (emph.has("destructive")) out.push("destructive-action");
    else if (emph.has("secondary")) out.push("secondary-action");
    else if (emph.has("primary")) out.push("primary-action");
    else out.push("action");
  }
  if (roles.has("text-input") && emph.has("password")) out.push("password-input");
  if (roles.has("dialog") && emph.has("destructive")) out.push("error-dialog");
  if (roles.has("alert") || roles.has("toast")) for (const k of ["destructive", "success", "warning"]) if (emph.has(k)) out.push(`${k === "destructive" ? "error" : k}-${roles.has("toast") ? "toast" : "alert"}`);
  return out;
}

function categorizeVariable(v: VariableDefinition): SemanticToken["category"] {
  const n = norm(`${v.collection} ${v.name}`);
  if (v.type === "COLOR") return "color";
  if (v.type === "FLOAT") {
    if (/(?:^| )(radius|radii|rounded|corner)(?= |$)/.test(n)) return "radius";
    if (/(?:^| )(space|spacing|gap|padding|margin|inset|gutter|stack)(?= |$)/.test(n)) return "spacing";
    if (/(?:^| )(font|type|line ?height|letter|text)(?= |$)/.test(n)) return "typography";
    if (/(?:^| )(size|width|height|icon)(?= |$)/.test(n)) return "size";
    const scopes = v.scopes ?? [];
    if (scopes.includes("GAP") || scopes.some((s) => s.includes("PADDING"))) return "spacing";
    if (scopes.includes("CORNER_RADIUS")) return "radius";
    if (scopes.includes("WIDTH_HEIGHT")) return "size";
  }
  return "other";
}

export function inferTextRole(name: string, fontSize: number): string {
  const n = norm(name);
  if (/(?:^| )(display|hero)(?= |$)/.test(n)) return "display";
  if (/(?:^| )(h1|heading ?1|title ?large|headline|heading|h2|title)(?= |$)/.test(n)) return /(?:^| )(sub|h3|h4|small)(?= |$)/.test(n) ? "subheading" : "heading";
  if (/(?:^| )(subtitle|subheading|h3|h4)(?= |$)/.test(n)) return "subheading";
  if (/(?:^| )(caption|footnote|helper|hint|small|xs)(?= |$)/.test(n)) return "caption";
  if (/(?:^| )(label|button|overline)(?= |$)/.test(n)) return "label";
  if (/(?:^| )(code|mono)(?= |$)/.test(n)) return "code";
  if (/(?:^| )(body|paragraph|text|regular|base)(?= |$)/.test(n)) return "body";
  if (fontSize >= 28) return "display";
  if (fontSize >= 20) return "heading";
  if (fontSize <= 12) return "caption";
  return "body";
}

/** Enrich a raw scan (from the plugin) with semantic hints and derived tokens. Pure & deterministic. */
export function enrichDesignSystem(raw: Omit<DesignSystem, "semanticTokens" | "typography"> & Partial<Pick<DesignSystem, "typography">>): DesignSystem {
  const setById = new Map(raw.componentSets.map((s) => [s.id, s]));
  const components: ComponentDefinition[] = raw.components.map((c) => {
    const set = c.componentSetId ? setById.get(c.componentSetId) : undefined;
    const variantValues = Object.entries(c.variants ?? {}).flatMap(([k, v]) => [k, v]);
    const hints = inferRoles(set ? `${set.name} ${c.name}` : c.name, `${set?.description ?? ""} ${c.description ?? ""}`, variantValues, c.dimensions, c.textLayers);
    return { ...c, componentSet: set?.name ?? c.componentSet, semanticHints: hints };
  });
  const componentSets: ComponentSetDefinition[] = raw.componentSets.map((s) => {
    const variants = components.filter((c) => c.componentSetId === s.id);
    const roles = new Set(inferRoles(s.name, s.description));
    for (const v of variants) for (const h of v.semanticHints ?? []) roles.add(h);
    return { ...s, semanticHints: [...roles] };
  });
  const typography: TypographyDefinition[] = (raw.typography ?? []).map((t) => ({ ...t, role: t.role ?? inferTextRole(t.name, t.fontSize) }));
  const semanticTokens: SemanticToken[] = [
    ...raw.variables.map((v) => ({ name: v.name, category: categorizeVariable(v), source: "variable" as const, refId: v.id, value: v.value })),
    ...raw.styles.filter((s: StyleDefinition) => s.type === "PAINT").map((s) => ({ name: s.name, category: "color" as const, source: "style" as const, refId: s.id, value: s.value })),
    ...typography.map((t) => ({ name: t.name, category: "typography" as const, source: "style" as const, refId: t.styleId, value: `${t.fontFamily} ${t.fontStyle} ${t.fontSize}` })),
  ];
  return { ...raw, components, componentSets, typography, semanticTokens };
}
