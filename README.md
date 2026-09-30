# Layerwright

**Turn Claude Design and Claude Code designs into native, editable Figma files.**

Layerwright is an open-source MCP server and Figma plugin that works with Claude Code. It imports
HTML (for example a Claude Design "standalone HTML" export) into Figma as real frames with Auto
Layout, text, images and vector icons, and it lets Claude build new screens from your own Design
System: real component instances, variables and text styles. It is not a screenshot and it is not a
flat SVG.

[![CI](https://github.com/shayan-m81/layerwright/actions/workflows/ci.yml/badge.svg)](https://github.com/shayan-m81/layerwright/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/layerwright.svg)](https://www.npmjs.com/package/layerwright)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/shayan-m81/layerwright/blob/main/LICENSE)

![Demo: an HTML page imported into Figma as editable Auto Layout frames, desktop and mobile](https://github.com/shayan-m81/layerwright/raw/main/docs/assets/demo.gif)

## Why

Claude Design exports to HTML, PDF, PPTX and Canva, but not to Figma. Claude Code can write UI code,
but it has no native way to put a design into a Figma file your team can edit. Most "HTML to Figma"
tools either paste a flat picture or need a cloud account.

Layerwright closes that gap locally:

- **Claude Design to Figma:** export standalone HTML, run one command, and you get editable Figma frames.
- **Claude Code to Figma:** ask Claude for a screen or a flow, and it is built from your Design System's components.
- **No API keys, no cloud, no account.** Everything runs on your machine. The plugin only talks to `localhost`.

## Features

- **HTML to Figma import** (`import_html_to_plan`)
  - Flexbox becomes Auto Layout: direction, gap, padding, alignment and wrap. Fixed CSS sizes stay fixed.
  - Colours, borders, radii, shadows, gradients, fonts, line height and letter spacing come across.
  - Text with inline `<b>`, `<span>` and `<a>` is one text layer with styled ranges.
  - Images and inline SVG icons are imported as real images and vectors.
  - Desktop (1440) and mobile (390) screens are rendered side by side.
  - RTL is supported (Persian, Arabic, Hebrew). Rows keep their visual order and text stays right-aligned.
- **Design System sync.** After an import, `figma_analyze_design({ mode: "sync" })` swaps buttons and pills for your DS components (the variant that looks closest), gives text your text styles by size and weight, and binds colours to your variables and styles. You approve it; originals are kept hidden.
- **Design System automation.** After a Design System scan, buttons, inputs and links become your real Figma components when they clearly match, and you can map any element yourself (`mappings: [{ selector, component }]`).
- **AI design to Figma from a prompt.** Claude writes a typed Design Plan (a JSON DSL). The plan is validated and resolved against your components, variables and text styles, then built deterministically. Claude never writes Figma plugin code.
- **Prototypes.** Click, hover and timed interactions, navigate / overlay / swap / back, smart animate and push transitions, scrolling frames and flow starting points, in plans or on existing frames.
- **Work on existing designs** (`figma_edit`). Rename, move, duplicate, delete, and turn existing frames into components or variant sets with text properties, in one undo step.
- **Figma back to a plan.** Any subtree exports as an editable Design Plan to clone, refactor or implement in code.
- **Accessibility and critique.** WCAG contrast (on the real background), touch-target and text-size checks, plus consistency signals; Claude uses them with a picture in a critique loop to polish what it builds.
- **You see what was built.** `figma_export_image` renders any node, and compares it with the source HTML (or another node) with a diff heatmap.
- **Safe by default.**
  - Every run is one undo step.
  - A failed run rolls back completely.
  - Results are checked against the plan: structure, sizes, variants, text overrides and prototype links.
  - Existing nodes change only after you approve; deleting without approval only hides and labels a layer.
  - Everything Layerwright creates is tagged, so `figma_cleanup` can list and remove a session's leftovers.
- **Audit and fix existing frames.** Hard-coded colours become variables, raw text gets text styles, and custom buttons become component instances, in groups you can pick. Originals are hidden, never deleted.
- **Design to code.** Map Figma components to your React components and check that the implementation uses them.
- **Pixel-faithful mode** (`figma_import_html`) for review boards and art-heavy pages: exact layers, variant sets built from states, and instance swaps.
- **Learns per project.** Font substitutions, mappings and component choices are reused next time, your corrections are kept as notes, and recurring problems come with a hint (`.layerwright/memory.json`, shareable). `npx layerwright report` drafts a redacted issue from them for you to send.
- **Tells you about updates** in the plugin window, in Claude and in `doctor`.
- **Fonts from exports:** `npx layerwright fonts ./export --install` installs the TTF/OTF fonts a design ships.
- **No AI needed for a plain import.** `npx layerwright import ./design.html --to-figma` builds it in the open Figma file.

## Quickstart (3 steps)

Requirements: Node.js 20+, Figma desktop, Claude Code (or Cursor: `npx layerwright init --cursor`).

```bash
# 1. In your project folder
npx layerwright init
```

2. In **Figma desktop**, go to **Plugins → Development → Import plugin from manifest…** and pick the path `init` printed (`~/.layerwright/figma-plugin/manifest.json`). Open your file and run **Layerwright**. Keep its small window open.
3. Restart **Claude Code** in the project and ask:
   - *"Import ./design.html into Figma"*: a Claude Design HTML export becomes editable frames.
   - *"Create a sign-up flow in Figma using our Design System"*: new screens built from your components.
   - Select a frame in Figma, then *"Implement the selected Figma frame in code using our components"*: Figma → code with your mapped React components and theme tokens, checked afterwards.

Want these rules always in Claude's context? Paste [this prompt](https://github.com/shayan-m81/layerwright/blob/main/docs/claude-prompt.md) into your project's `CLAUDE.md`.

Something not working? Run `npx layerwright doctor`.

For HTML import, Layerwright needs a Chromium. It uses Google Chrome if you have it installed. Otherwise run `npx playwright install chromium`.

Want to try the conversion without Figma? `npx layerwright import ./design.html` prints what would be built.
Want it in Figma without Claude? Run the plugin, then `npx layerwright import ./design.html --to-figma --page "Designs"`
(`--faithful` for exact layers, `--scan` to use your Design System's components).

## How it works

```mermaid
flowchart LR
  A[Claude Code] -- MCP / stdio --> B[layerwright server]
  H[HTML file or folder] -- headless Chromium --> B
  B -- "Zod-validated Design Plan<br/>resolved against your DS" --> B
  B -- ws://localhost --> C[Figma plugin]
  C -- "fixed Plugin API calls<br/>one undo step" --> D[(Figma file)]
```

1. **Plan.** Claude, or the HTML importer, produces a **Design Plan**: a small, typed JSON DSL of screens, frames, text, components, tokens and images.
2. **Validate and resolve.** The server checks the plan with Zod. It then resolves every component, variant, property, variable and text style against a cached scan of *your* Figma file. Unknown names come back as errors with suggestions and never reach Figma.
3. **Execute.** The plugin builds the resolved plan with fixed Plugin API calls. There is no `eval` and no model-written code.
4. **Verify.** The result is re-inspected and compared with the plan and, for HTML imports, with the page's rendered boxes. `figma_export_image` shows the result next to the source.

Read more in [docs/architecture.md](https://github.com/shayan-m81/layerwright/blob/main/docs/architecture.md). The DSL is documented in [docs/dsl.md](https://github.com/shayan-m81/layerwright/blob/main/docs/dsl.md).

## MCP tools

| Tool | What it does |
|---|---|
| `import_html_to_plan` | HTML file or folder → editable Design Plan (Auto Layout, DS components, your own mappings). Returns a `planId` |
| `figma_execute_plan` | Builds a plan in Figma: one undo step, rollback on failure, automatic verification |
| `figma_preview_plan` | Validates and resolves a hand-written plan and returns a summary |
| `figma_edit` | Rename, move, duplicate, set, delete, resize to fit, componentize (variants, text properties), swap instances, annotations, prototype links and flows |
| `figma_export_image` | A node as an image; compared with the source HTML or another node, with a diff heatmap |
| `figma_status` / `figma_scan_design_system` / `figma_get_design_context` | Connection and page, Design System scan (components, variants, variables, styles, duplicate names), task-scoped context |
| `figma_inspect` / `figma_verify` / `figma_select` | Snapshots (tree, summary, text, instances, or the subtree as a plan), plan-vs-canvas checks, select and zoom (switches page) |
| `figma_analyze_design` / `figma_apply_transformations` | Audit a frame against the DS, or `mode: "sync"` after an import; apply the groups you approve |
| `figma_import_html` / `figma_pages` / `figma_foundations` | Pixel-faithful import, page setup, variables and text styles |
| `figma_migrate` | Move every instance of one component set to another, variant by variant, keeping overrides (dry run first) |
| `figma_cleanup` | List (and with approval remove) what Layerwright made in this session |
| `layerwright_memory` | What the project remembers (fonts, mappings, component choices, notes, recurring problems); add notes or forget entries |
| `code_scan_components` / `code_mapping` / `code_verify_usage` | Design to code: component mapping and usage checks |

## FAQ

**Is this an official Anthropic or Figma product?**
No. It is an independent open-source project that works with Claude Code and Figma.

**Does it need an API key, an account or a server?**
No. Claude Code runs the MCP server locally, and the Figma plugin connects to it on `localhost`. Nothing is uploaded.

**Can I use it without Claude Code?**
Yes. `npx layerwright import ./design.html --to-figma` builds an HTML file in Figma with no AI at all, and any MCP client can call the tools. The skill and the design workflows (building from a prompt, componentizing, prototyping) are written for Claude Code.

**Can it make prototypes?**
Yes. Plans and `figma_edit` set click, hover, press, drag and timed interactions (navigate, overlay, swap, scroll to, change to, back, close, open URL) with transitions, scrolling frames and flow starting points. Overlays open centred: the Plugin API can't set their position.

**Does it work with the official Figma MCP?**
It doesn't need it. If it's connected, Claude can use its library search to find a component your file doesn't use yet and pass its key to Layerwright.

**Does the output use Auto Layout?**
Yes, where the HTML uses flexbox or evenly spaced stacks. Grid and overlapping layers become frames with absolutely positioned children, so the result still looks right.

**Will it use my Design System?**
Yes. Scan the file that has your components (`figma_scan_design_system`), and imported buttons, inputs and links become instances of them. Anything that doesn't match stays a styled frame.

**Does it work with right-to-left languages?**
Yes. Direction, text alignment and row order are preserved. Fonts such as Vazirmatn are matched to their real style names.

**Does it work in the Figma browser app?**
Development plugins need Figma desktop.

## Troubleshooting

Start with `npx layerwright doctor`. It checks Node, `.mcp.json`, the skill, the plugin files, the running server, the plugin connection and Chromium, and it prints a fix for each problem. More cases are covered in [docs/troubleshooting.md](https://github.com/shayan-m81/layerwright/blob/main/docs/troubleshooting.md).

## Limitations

- CSS grid, floats and transforms are imported as positioned layers, not as Auto Layout.
- Linear, radial and conic gradients and `blur()`/`backdrop-filter: blur()` come across; other filters and blend modes are dropped in plan mode (the pixel-faithful mode keeps blend modes). Only the top background layer is used.
- The largest corner radius is used when the four corners differ.
- Fonts must be installed on the machine that runs Figma. A missing family falls back to Inter, with a warning.
- Images must be PNG, JPEG or GIF (a Figma limit), up to 10 MB each.
- The scan finds library components only when an instance of them exists in the open file. Others can be used by key (e.g. found with the official Figma MCP's library search).
- Prototype overlays open centred (their position can't be set through the Plugin API). Plans can't hide instance layers by override yet.
- One Figma plugin connection per port. Parallel sessions need separate ports from 7331–7340 (`LAYERWRIGHT_PORT`, and the same port in the plugin window).

## Roadmap

- Per-corner radii, CSS grid → Auto Layout wrap
- Design tokens export (W3C format) and import
- Figma Community listing ([plan](https://github.com/shayan-m81/layerwright/blob/main/docs/figma-community-plan.md))
- Instance-swap properties and hidden-layer overrides in plans

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/shayan-m81/layerwright/blob/main/CONTRIBUTING.md). To develop from a clone:

```bash
git clone https://github.com/shayan-m81/layerwright && cd layerwright
npm install && npm run build && npm test
npx tsx apps/mcp-server/src/cli.ts init   # wires this checkout into the current folder
```

## License

[MIT](https://github.com/shayan-m81/layerwright/blob/main/LICENSE) © Shayan Montazeri

---

*Keywords: claude design to figma, export claude design, claude code figma, html to figma, figma mcp, ai design to figma, design system automation.*

Not affiliated with, endorsed or sponsored by Anthropic or Figma. Claude is a trademark of Anthropic; Figma is a trademark of Figma, Inc.
