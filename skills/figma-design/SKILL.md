---
name: figma-design
description: Work as a Design Engineer in Figma through the layerwright MCP tools (figma_*, code_*). Use when a task involves designing or changing screens/flows in Figma, applying or auditing the Design System on a Figma frame, inspecting Figma components, or implementing/verifying frontend code against a Figma design. Do not use for ordinary coding tasks with no design component.
---

# Figma Design Engineer

You are the reasoning layer. The `layerwright` MCP server and its Figma plugin are
deterministic hands: they scan, resolve, execute and verify. You never write Figma JavaScript —
you write a **Design Plan** (JSON DSL) and the executor builds it with real components, Auto
Layout, variables and styles.

## When to use it

Use it for: new screens or flows, changes to existing designs, applying the Design System (DS)
to rough UI, inspecting components, design → code, and checking that design and code match.
Don't use it for code-only tasks (bugs, refactors, APIs) unless the user brings up the design.

## Golden rules (they save tokens and prevent broken work)

1. **Reason once, act in batches.** Write one full plan per screen set. Never call tools once per node.
2. **Context is compact on purpose.** Use `figma_get_design_context` for the task. Don't ask for the whole DS; call `figma_inspect` with a small `depth` unless you need more.
3. **Reuse before you create.** Every button, input, link, card or modal should be a DS component (`type: "button" | "input" | "component"`). Use `allowFallback: true` only when the user accepts a placeholder, and say so when you do.
4. **Tokens over raw values.** Use the token names returned by the context (`"spacing/md"`, `"color/text/secondary"`, text styles through `role` or `style`). Raw numbers or hex are fine when no token fits.
5. **Approval boundary.** Always show the plan summary before you execute. Apply a Mode B transformation only after the user says yes, then pass `approved: true`. Never delete user work. Replaced nodes are hidden and renamed, never removed.
6. **Errors are data.** Tools return `{ success:false, errors:[{type, message, suggestions}] }`. Fix the plan using the suggestions (a different component name, variant or token) and preview again. If no component exists, ask the user rather than inventing one.

## Setup check (first time in a session)

`figma_status` → if it isn't connected, tell the user: *Figma desktop → Plugins → Development →
Layerwright*. Then run `figma_scan_design_system` (it's cached; pass `refresh: true` after the DS changes).
The scan summary lists component sets with their variants, variable collections and roles. Read it once.

## Mode 0 — HTML → Figma (cheapest; use it whenever HTML exists)

Never re-type an HTML design (a Claude Design "standalone HTML" export, a prototype, a local page) as a Design Plan by hand. Let the tools read it.

**Editable import (default):** `import_html_to_plan({ path, viewport?, useDesignSystem? })`
- `path` is an .html file or a folder with index.html. The default viewports are `[1440, 390]` (desktop and mobile screens side by side).
- Flexbox becomes Auto Layout. Evenly spaced block stacks become vertical Auto Layout. Grid and overlapping layers become frames with absolutely positioned children. Colours, borders, radii, shadows, gradients, fonts, text (including RTL), images and SVG icons are all carried over.
- When a Design System is scanned (the default when one is cached), buttons, inputs and links become real DS components. `mappedToDesignSystem` in the result says which ones.
- It returns a `planId`. Show the summary, then call `figma_execute_plan({ planId })`. Undo, rollback and verification work as in Mode A.

**Pixel-faithful import (review boards, heavy art):** `figma_import_html({ file, page?, section?, dryRun? })`
- This rebuilds exactly what was painted, as absolutely positioned layers.
- On a review board (nested `.sc-host`), each state becomes its own screen, named by its label.
- `targets: [{ selector, name, index? }]` picks elements. `components: true` plus names like `"Card/State=Chosen"` builds variant sets. `swaps` turns matched elements into instances of those components, with their content as overrides. `actions: [{ click }]` captures opened menus and later steps.
- `figma_pages({ pages })` sets up the file structure. `figma_foundations({ colors, numbers, textStyles })` creates variables and text styles. Afterwards, Mode B binds the layers to them.

Fonts must be installed on the machine that runs Figma. A missing family falls back to Inter, with a warning.

## Mode A — requirement → Figma design

1. **Understand the flow.** List the screens and the states each one needs (default, loading, error, empty, success), plus how the user moves between them. Keep this short and in your own head or reply.
2. `figma_get_design_context({ task: "<flow description>", roles?: [...] })` returns only the relevant components (with their variants and props), tokens and text styles, plus any known code mappings.
3. **Write one Design Plan** that covers all the screens (see the DSL below). Put screens side by side, one screen per state when states differ visually, and give them clear names such as `"Reset – Enter email"` and `"Reset – Code (error)"`.
4. `figma_preview_plan({ plan })` validates the plan and resolves it. If it fails, fix it and preview again. If it succeeds, show the user the `summary` (screens, instances by component, tokens, warnings).
5. Once the user approves (or has already said "go ahead"), call `figma_execute_plan({ planId })`. The whole plan is one undo step, a failure rolls it all back, and the result is verified automatically.
6. Report the created screens, anything in `verification.mismatches` and the warnings. Use `figma_select` to show the result.

## Mode B — make an existing frame follow the DS

1. Ask the user to select the frame, or use the node id they give you.
2. `figma_analyze_design()` returns a grouped summary, for example "3 × custom element → Button / Primary", "7 × spacing value → spacing token", "1 × manual layout → Auto Layout".
3. Present the summary and ask which items to apply. Nothing changes until you do.
4. `figma_apply_transformations({ analysisId, approved: true, ids? })` applies them. Report `applied` / `failed` and remind the user that originals are hidden, not deleted, and that one undo reverts everything.
5. For changes the analyzer can't express (restructuring, new sections), write a Design Plan with `target: { parentId }` and use Mode A. That path needs `approved: true`.

## Mode C — Figma → code, and verification

1. `figma_inspect({ target: <frame id>, depth: 8 })` gives you the structure. Or reuse the plan you just executed.
2. `code_scan_components()` finds the framework (Next app router, Tailwind, shadcn), the existing UI components and `mappingSuggestions`. Confirm the mappings that are right and save them with `code_mapping({ action: "set", mappings })`. The mapping file `.layerwright/mapping.json` should be committed.
3. Implement with the **mapped components**, and import them from their `importPath`. Never re-implement a component that's already mapped. Map DS tokens to the project's token system (Tailwind theme, CSS variables) and avoid arbitrary values.
4. `code_verify_usage({ file, planId })` flags mapped components that are missing, raw `<button>`/`<input>` duplicates and arbitrary Tailwind values. Fix them and run it again. If needed, run `figma_verify({ planId })` to confirm Figma still matches.

## Design DSL (validated with Zod; invalid plans never reach Figma)

```jsonc
{
  "name": "Login flow",
  "screenGap": 80,                       // px between top-level screens
  "target": { "parentId": "12:34" },     // optional: build inside an existing node (needs approval)
  "screens": [ /* DesignNode[] — usually type "screen" */ ]
}
```

**Containers.** `screen` (fixed width, 390 by default), `frame`, `section`, `stack` (vertical), `row` (horizontal), `card`, `modal`, `navigation` and `list` share these fields:
`name, width (number|"hug"|"fill"), height, minWidth, maxWidth, layout { direction: vertical|horizontal|none, gap, padding (n | {x,y} | {top,right,bottom,left}), align: start|center|end|space-between, crossAlign, wrap }, fill, gradient { angle, stops:[{color, position 0–1}] }, stroke, strokeWeight, strokeSides (e.g. ["top"]), strokeWeights {top,right,bottom,left}, radius, effect (an effect style) or shadows [{type: drop|inner, x, y, blur, spread, color}], opacity, clip, direction: "rtl" (reverses horizontal children and right-aligns text: Persian, Arabic, Hebrew), children[]`.
Any node takes `position: { type: "absolute", x, y }` to leave the Auto Layout flow (for badges and overlays).
Each type comes with a sensible default layout (for example, `screen` uses padding 24 and gap 16, and `card` uses padding 16, gap 12 and radius 12).
A container that has `component` or `role` set becomes a DS instance instead, which is useful for a card, modal or navigation bar from the DS.

**Content.**
- `text`: `content`, `role` (display|heading|title|subheading|body|label|caption|overline|code, which picks the matching DS text style), `style` (an explicit text style name), `color`, `fontSize`, `fontFamily` (for example "Vazirmatn"), `weight` (thin…black; matched to the font's real style names), `italic`, `lineHeight` `{unit: px|percent, value}` or `{unit: "auto"}`, `letterSpacing` `{unit, value}`, `align`, `direction`.
- `link`: `content`, `href`. It uses the DS Link component if one exists and otherwise renders as link-colored text.
- `button`: the default role is `primary-action`. `input`: the default role is `text-input`. `icon`, `component` and `component-instance` are the others. All of them take:
  `component` (a name such as `"Button"` or `"Forms/Input"`), `role` (such as `primary-action`, `secondary-action`, `destructive-action`, `text-input`, `password-input`, `otp-input`, `checkbox`, `switch`, `select`, `dialog`, `toast`, `alert`, `card`, `navigation`, `tabs`, `list-item`, `avatar` or `badge`),
  `variant` (`"Secondary"`, `"Primary, Small"` or `{ "Type": "Primary", "Size": "Small" }`) and `props` (`{ "label": "Email", "placeholder": "you@x.com", "disabled": true }`). Props map to component properties by name and fall back to text layer names.
- `divider`: uses the DS divider component, or a 1px rule if there isn't one.
- `image`: `src` (a `data:image/…` URL or an https URL, which the server fetches; the plugin never goes online), `fit` (fill|fit|crop), `alt`, `radius`. If an image fails to load, it stays a placeholder and you get a warning.
- `icon`: either a DS icon component (`component`/`role`) or `svg` (inline `<svg>` markup), plus an optional `color` that recolours it.

**Tokens.** A numeric field accepts a number or a variable name (`"spacing/md"`). A color accepts a variable name, a paint style name or a hex value.
**Sizing.** Children of vertical containers stretch (`fill`) by default. Use `width: "hug"` to stop that, for example on an inline button.

### Example

```json
{ "name": "Login", "screens": [
  { "type": "screen", "name": "Login", "fill": "color/bg/surface",
    "layout": { "direction": "vertical", "padding": "spacing/lg", "gap": "spacing/md" },
    "children": [
      { "type": "text", "role": "heading", "content": "Welcome back" },
      { "type": "text", "role": "body", "content": "Sign in to continue", "color": "color/text/secondary" },
      { "type": "input", "props": { "label": "Email", "placeholder": "you@company.com" } },
      { "type": "input", "role": "password-input", "props": { "label": "Password" } },
      { "type": "button", "variant": "Primary", "props": { "label": "Continue" } },
      { "type": "row", "layout": { "direction": "horizontal", "align": "center" }, "children": [
        { "type": "link", "content": "Forgot password?" } ] }
    ] } ] }
```

## Error types you may see

`INVALID_PLAN` (schema, with a path) · `COMPONENT_NOT_FOUND` / `INVALID_VARIANT` (with suggestions) · `TOKEN_NOT_FOUND` / `STYLE_NOT_FOUND` ·
`DESIGN_SYSTEM_NOT_SCANNED` · `PLUGIN_DISCONNECTED` · `TIMEOUT` (inspect before you retry, since the operation may have completed) · `NOT_APPROVED` · `FIGMA_API_ERROR` (execution was rolled back).
