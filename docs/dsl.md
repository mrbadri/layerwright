# Design DSL reference

A **Design Plan** is the only thing the model (or the HTML importer) produces. It is validated with
Zod (`packages/core/src/dsl.ts`) and resolved against the scanned Design System before anything
reaches Figma. An invalid plan returns structured errors and never runs.

```jsonc
{
  "name": "Login flow",
  "screenGap": 80,                     // px between top-level screens
  "target": { "page": "Flows" },       // optional: page name or id (default: the current page)
                                       // or { "parentId": "12:34" }: build inside an existing node (needs approval)
  "prototype": { "flows": [{ "name": "Login", "start": "Login" }] },  // optional: flow starting points
  "screens": [ /* DesignNode[], usually type "screen" */ ],
  "inserts": [ { "parentId": "40:2", "index": 0, "nodes": [ /* DesignNode[] */ ] } ]  // optional: fill existing parents (needs approval)
}
```

A plan needs `screens`, `inserts`, or both.

## Containers

`screen` · `frame` · `section` · `stack` (vertical) · `row` (horizontal) · `card` · `modal` · `navigation` · `list`

A `section` at the top level of a plan is a real Figma Section: its children are placed side by side (or
stacked with `layout.direction: "vertical"`), it fits its content, and it grows when a later plan adds
to it. A nested `section` is a vertical stack.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Layer name |
| `width`, `height` | number \| `"hug"` \| `"fill"` | Children of vertical containers fill by default |
| `minWidth`, `maxWidth` | number | Auto Layout frames and their children only |
| `layout` | `{ direction, gap, padding, align, crossAlign, wrap }` | `direction`: vertical \| horizontal \| none. `padding`: n \| `{x,y}` \| `{top,right,bottom,left}`. `align`: start \| center \| end \| space-between. `crossAlign`: start \| center \| end \| baseline |
| `fill` | color | Variable name, paint style name or hex (`#RRGGBB[AA]`) |
| `gradient` | `{ angle, stops: [{ color, position }] }` | Linear. CSS angles (180 = top to bottom) |
| `stroke`, `strokeWeight` | color, number | |
| `strokeSides` | `["top" \| "right" \| "bottom" \| "left"]` | Draw only these sides |
| `strokeWeights` | `{ top, right, bottom, left }` | Per-side widths |
| `radius` | number \| token | |
| `effect` | string | An effect style name |
| `shadows` | `[{ type: drop \| inner, x, y, blur, spread, color }]` | Raw shadows when no style fits |
| `opacity` | 0–1 | |
| `clip` | boolean | Clip content |
| `direction` | `"ltr"` \| `"rtl"` | `rtl` reverses horizontal children and right-aligns text inside |
| `scroll` | `"none"` \| `"vertical"` \| `"horizontal"` \| `"both"` | Prototype scrolling |
| `fixedChildren` | number | Prototype: the first n children stay fixed while scrolling |
| `component`, `role`, `variant`, `props` | | Makes the container a DS instance instead |
| `children` | DesignNode[] | Up to 200 per container |

Every node also accepts `position: { "type": "absolute", "x": 8, "y": 8 }`, which takes it out of
the Auto Layout flow. Use it for badges, overlays and decorations.

Defaults: `screen` is 390 wide with padding 24 and gap 16. `card` has padding 16, gap 12 and radius 12. `row` has gap 8 and centred items.

## Content

**`text`**: `content`, `role` (display \| heading \| title \| subheading \| body \| label \| caption \| overline \| code), `style` (a text style name, or `null` for none), `color`, `fontSize`, `fontFamily`, `weight` (thin \| extralight \| light \| regular \| medium \| semibold \| bold \| extrabold \| black), `italic`, `lineHeight` (`{unit: "px" | "percent", value}` or `{unit: "auto"}`), `letterSpacing` (`{unit, value}`), `align` (left \| center \| right \| justified), `direction`, `runs`.

Which typography wins: an explicit `style` is applied, and explicit font fields override it. A `role` picks a DS text style only when the text sets no font fields of its own. Without `role` or `style`, no style is applied.

`runs: [{ text, weight?, italic?, fontFamily?, fontSize?, color?, href? }]` styles pieces of one text (a bold word, a link). Their texts joined must equal `content`.

Fonts are matched to what is installed: "Semi Bold" and "SemiBold" are treated as the same style, and the nearest weight wins. A missing family falls back to Inter with a warning. Text never fails because of a font.

**`link`**: `content`, `href`. Uses the DS Link component when there is one. Otherwise it renders as link-coloured text.

**`button`** (default role `primary-action`), **`input`** (default role `text-input`), **`component`**, **`component-instance`**: `component` (a name, or `{ "id": "12:34" }` / `{ "key": "…" }` for an exact component or set; a key that isn't in the scan is imported from its library, and its variants and props are matched by name), `role`, `variant` (`"Secondary"`, `"Primary, Small"` or `{ "Type": "Primary" }`), `props` (component properties by name, falling back to text layers), `allowFallback` (draw a labelled placeholder when nothing resolves).

**`icon`**: either a DS icon (`component`/`role`), or `svg` (inline `<svg>…</svg>` markup) plus an optional `color` that recolours every vector.

**`image`**: `src` (a `data:image/png|jpeg|gif;base64,…` URL, or an https URL that the **server** fetches, so the plugin never goes online), `fit` (fill \| fit \| crop), `alt`, `radius`, `fill` (the placeholder colour). If an image fails to load, it stays a placeholder and you get a warning.

**`divider`**: the DS divider component, or a 1px rule.

## Prototype

Every node takes `id` (a plan-local name to point at) and `interactions`:

```jsonc
{ "type": "button", "props": { "label": "Pay" },
  "interactions": [{ "trigger": "click", "action": "navigate", "to": "Success",
                     "transition": { "type": "smart-animate", "duration": 400, "easing": "gentle" } }] }
```

| Field | Values |
|---|---|
| `trigger` | `click` (default) · `hover` · `press` · `drag` · `mouse-enter` · `mouse-leave` · `after-delay` (with `delay` in ms) |
| `action` | `navigate` · `overlay` · `swap` · `scroll-to` · `change-to` · `back` · `close` · `url` (with `url`) |
| `to` | a node `id` in this plan, a screen name in this plan, or an existing Figma node id |
| `transition` | `type`: `instant` · `dissolve` · `smart-animate` · `move-in` · `move-out` · `push` · `slide-in` · `slide-out`; `direction` (left · right · top · bottom); `duration` (ms, default 300); `easing` (ease-out · ease-in · ease-in-out · linear · ease-in-back · ease-out-back · gentle · quick · bouncy · slow) |
| `preserveScroll` | keep the scroll position |

Navigate, overlay and swap targets must be top-level frames (on the page or in a section) of the same
page. Overlays open centred: their position can't be set through the Plugin API.

## Tokens

A numeric field takes a number or a variable name (`"spacing/md"`). A colour takes a variable name,
a paint style name or a hex value. Shadow and gradient colours must be hex values or colour
variables with a plain value.

## Example

```json
{ "name": "Login", "screens": [
  { "type": "screen", "name": "Login", "fill": "color/bg/surface", "direction": "ltr",
    "layout": { "direction": "vertical", "padding": "spacing/lg", "gap": "spacing/md" },
    "children": [
      { "type": "text", "role": "heading", "content": "Welcome back" },
      { "type": "input", "props": { "label": "Email", "placeholder": "you@company.com" } },
      { "type": "button", "variant": "Primary", "props": { "label": "Continue" } },
      { "type": "image", "src": "https://example.com/hero.png", "fit": "crop", "height": 160, "radius": 16 },
      { "type": "frame", "name": "Badge", "width": 28, "height": 28, "radius": 14, "fill": "#176B66",
        "position": { "type": "absolute", "x": 12, "y": 12 } }
    ] } ] }
```

## Errors

`INVALID_PLAN` (schema, with a path) · `COMPONENT_NOT_FOUND` / `INVALID_VARIANT` (with suggestions) · `AMBIGUOUS_COMPONENT` (several components share the name; `candidates` lists their ids, pages and variants) · `TOKEN_NOT_FOUND` / `STYLE_NOT_FOUND` · `DESIGN_SYSTEM_NOT_SCANNED` · `PLUGIN_DISCONNECTED` · `TIMEOUT` · `NOT_APPROVED` · `FIGMA_API_ERROR` (execution was rolled back).
