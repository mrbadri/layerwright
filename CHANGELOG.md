# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-30

### Added
- Long operations don't time out while Figma works: the plugin reports progress (scans, builds, imports, edits, Design System sync), the plugin window forwards it, and each update gives the request its full time again (up to 30 minutes). A real timeout names the last thing Figma was doing.
- Accessibility and critique: `figma_analyze_design({ mode: "a11y" })` checks text contrast against its real (blended) background (WCAG 1.4.3), touch targets (2.5.8; 44px recommended) and tiny text; `mode: "critique"` adds consistency signals (spacing off the scale or the 4px rhythm, font-size count, raw colours, near-miss alignment). The skill runs a critique loop (picture + numbers → scores for hierarchy, spacing, alignment, contrast, consistency, density → fix → up to 3 rounds) after building from a prompt.
- `figma_edit` `swap` (an instance to another component or variant, keeping its overrides) and `annotate` (native Figma annotations: markdown, live measured properties, a category created if needed). Plans take `annotations` on any node, `figma_inspect` shows them, and the plan export keeps them.
- `figma_foundations` also creates colour styles (hex, gradient, or bound to a colour variable), effect styles (shadows, layer and background blur) and grid styles (columns, rows, square grid); colour variables keep their alpha. `figma_edit` has `bind` (a variable to fills, strokes, gap, padding, radius, size, opacity) and `style` (a fill, stroke, text or effect style).
- Gradients can be linear, radial, angular (CSS conic) or diamond, in plans, colour styles and HTML imports; frames take `blur` (layer blur) and `backgroundBlur`, and imports keep CSS `filter: blur()` and `backdrop-filter: blur()`.
- Shapes: plans take `shape` nodes (ellipse with an optional arc for rings and progress, line, polygon, star), and the plan export turns Figma ellipses, lines, polygons and stars back into them. `figma_edit` has `group`, `ungroup` and `boolean` (union, subtract, intersect, exclude, flatten; the result keeps the base layer's paint).
- MCP prompts for clients without skills: `figma_design` (the whole guide), `html_to_figma`, `build_in_figma`, `change_figma`, `figma_to_code`. They are cut from the skill at run time (no second copy to drift), and the server sends short instructions that point at them.
- The skill has a text-replacement strategy (find with `format: "text"`, prefer instance TEXT properties over layer overrides, one batch, mixed-style texts, longer copy and other scripts).
- `figma_migrate`: moves every instance of one component set to another (old → new set, one library → another), matching variants and mapping renamed properties or values; a dry run first, then one undo step.
- Copies of one published library component (the same key under several node ids) count as one component, so they no longer make a name ambiguous.
- Cursor: `layerwright init --cursor` (automatic when the project has a `.cursor` folder) registers the server in `.cursor/mcp.json` and installs the skill as a Cursor rule; `doctor` checks it.
- **Design System sync after an import:** `figma_analyze_design({ mode: "sync" })` matches a fresh import to the DS like a designer: buttons and pills become DS components with the closest-looking variant (size by height, hierarchy and colour by fill, text colour and border; resting state), text gets the style with the same size and weight in the same script (even when the import used a stand-in font), colours get variables or colour styles.
- **Scan works on big library files:** main components are looked up in parallel (a real file went from over 5 minutes to about 12 seconds), library text/colour/effect styles and variables used in the file are found through the layers that use them, each variant's look and each set's usage are recorded, and copies of one library set resolve to the one the file uses most. Progress shows in the plugin window.
- **Plugin window:** status with file, page and selection; progress bar; an activity list in plain words; errors explained in plain words with the technical line below; update banner; version and build; connection settings folded away.
- **Update notice:** the server checks npm once a day (off with `LAYERWRIGHT_NO_UPDATE_CHECK=1`, never in CI) and shows a newer version in the plugin window, in `figma_status` (so Claude tells you) and in `doctor`.
- **Project memory** (`.layerwright/memory.json`): font substitutions and component mappings are reused by later imports, a choice between same-named components is remembered, the user's corrections are kept as notes (`layerwright_memory`), and recurring problems appear in `figma_status` with a hint.
- `layerwright report` drafts a redacted GitHub issue from the recurring problems for you to review and send; nothing is uploaded.
- `layerwright fonts <folder> [--install] [--only <name>]` lists the fonts an export ships and installs its TTF/OTF files for the current user.
- HTML import: text mixed with inline elements (`<b>`, `<span>`, `<a>`, `<br>`) is one text layer with styled ranges (weight, colour, size, links), in logical order for RTL, instead of many positioned layers. The DSL's `text` takes `runs`.
- HTML import: `mappings: [{ selector, component, variant?, props? }]` turns chosen elements into a component (`"$text"` = the element's text), ahead of automatic matching. `fontMap` replaces font families (also in `figma_import_html`).
- A font that's missing because the page only ships it as `.woff`/`.woff2` now says so and suggests installing a TTF/OTF or using `fontMap`. Missing-font warnings come once per family.
- `layerwright import <file> --to-figma` builds an HTML file in the open Figma file without Claude or any MCP client: it starts the bridge, waits for the plugin, builds, verifies and prints a report (`--page`, `--faithful`, `--section`, `--scan`, `--port`). `import_html_to_plan` takes `page` too.
- **Prototypes.** Any plan node takes an `id` and `interactions: [{ trigger, action, to, transition }]`: click, hover, press, drag, mouse enter/leave and after-delay triggers; navigate, overlay, swap, scroll-to, change-to, back, close and url actions; instant, dissolve, smart animate, move, push and slide transitions with easing and duration. `to` is a plan id, a screen name or a Figma node id. Screens take `scroll` and `fixedChildren`; plans take `prototype.flows`. `figma_edit` has `prototype` and `flow` ops for existing frames and interactive components. Interactions are verified, shown by `figma_inspect`, and kept in the plan export. (Overlay position can't be set through the Plugin API; overlays open centred.)
- `figma_inspect({ format })`: `summary` (counts, instances per component, top-level children), `text` and `instances` (flat lists with `offset`/`limit`), and `plan`: the subtree as a Design Plan (layout, tokens, text styles or fonts, instances by set id with variants, props and overridden text) to clone, refactor or implement. Very large trees return a hint instead of a huge answer.
- `figma_export_image({ compareWith: { nodeId } })` diffs two Figma nodes (before/after, original/rebuild).
- Plans take `inserts: [{ parentId, index?, nodes }]` to fill several existing parents in one run and undo step (needs approval).
- `figma_scan_design_system`: `reload` re-reads the cache file, `maxInstances` sets how many instances are checked for library components, and the summary lists `duplicateNames` (sets that share a name, with ids and pages). The plugin watches component and style changes, and `figma_status` says when the scan is stale.
- `figma_edit`: rename, move (to a parent, section or page), duplicate, set (visibility, position, size, opacity, text, instance properties), delete, resizeToFit and componentize, in one undo step. Ops can refer to earlier results (`"$0"`). Changing existing nodes needs `approved: true`; without it, delete only hides the node and prefixes 🗑.
- Componentize turns existing frames into a component, several components, or one component set (`variants: [{ State: "Expanded" }, …]`). It works on copies by default, placed next to the originals, can expose text layers as TEXT properties (`exposeText`), and gives cleanly stacked layers Auto Layout so the component adapts to new text.
- `target.page` in plans (name or id): the plan builds there, never silently on whatever page is open. `figma_select` switches to the page of the nodes; `figma_status` warns when Figma shows a different page than the last build.
- A top-level `section` in a plan is a real Figma Section sized to its content, and sections grow when a later plan adds to them.
- The plugin reports its build stamp (`pluginBuild` in `figma_status`), so a stale plugin window is visible.
- `figma_cleanup`: lists what Layerwright made in this session (or a run, or all), and removes it with `approved: true`. Every created root is tagged with its session and run.
- `figma_export_image`: a PNG/JPG of any node, returned as an image. With `compareWith: { html }` it also screenshots the source in headless Chrome and returns a diff heatmap plus the changed regions.
- Verification checks sizes against the plan and against the source's rendered boxes (HTML imports), text overrides inside instances, and layers hidden by overrides. `figma_import_html` now verifies screen sizes too.
- `figma_inspect({ expandInstances: true })`: the layers inside instances (text, hidden layers) and which ones are overridden.

### Fixed
- HTML import: a gradient that fades to `transparent` (glows, scrims) keeps its clear stop, in the neighbour's colour as CSS draws it, instead of losing the whole gradient; only a hard-edged transparent→colour radial is still read as a corner fillet.
- A stale layer id in `figma_edit` (deleted, undone, ungrouped) now says to fetch current ids with `figma_inspect`, instead of suggesting a Design System rescan.
- Problems say what to do: changes that didn't apply come back grouped by cause with the fix (e.g. "20 × library not enabled for this file → Assets panel → Libraries…", "font not installed: Gilroy → your export ships it: `npx layerwright fonts … --install --only Gilroy`"), once instead of once per layer, in Claude and in the plugin window. The scan says when library styles can't be applied and why.
- HTML import, found on a real Claude Design export:
  - Colours written as `oklch()`, `lab()`, `hsl()`, `color-mix()` and the like (Claude Design's default) were dropped; any CSS colour is now converted to sRGB.
  - An absolutely positioned overlay on a one-child box was imported twice (once in the flow).
  - Progress rings (SVG `stroke-dasharray` + `stroke-dashoffset`, rotated with CSS) became full circles; they are now real arcs, and a CSS transform on an `<svg>` is kept.
  - An empty frame stretched in a hugging row came out 100px tall; a frame whose width was just its content now hugs (so a wider fallback font widens it instead of wrapping); a single line of text in a column hugs unless the column's width is fixed.
  - One line of text in two fonts counted as two lines, which fixed its width and made it wrap in Figma.
  - Absolutely positioned layers that come before the flow in the HTML (a stepper's connector line) stay behind it.
- `import_html_to_plan` takes `targets` (several elements, each its own screen, e.g. the cards of a review board) and `target` (build inside a section or node, with approval).
- `figma_inspect` failed on a whole frame when one instance's component set has errors ("Component set for node has existing errors"); such instances now report their variant from the component name.
- Componentize kept DS instances linked but wrapped them in an Auto Layout frame, which in real Figma threw right-aligned text out of the box; the wrapper is now a plain frame of the instance's size.
- `figma_preview_plan` no longer needs a Design System scan for plans that use only raw values; plans that reference components or tokens say so. The scan timeout is 10 minutes for very large files.
- Text that should hug inside a frame without Auto Layout made Figma throw ("node must be an auto-layout frame or a child of an auto-layout frame") and rolled the whole import back.
- Another port than 7331 could never work: the plugin manifest only allowed `ws://localhost:7331`. It now allows 7331–7340, and the plugin window, `init --port` and the server refuse ports outside that range with a clear message. `doctor` also flags a plugin window that still runs an older build than the installed one.
- Text: explicit `fontSize`/`fontFamily`/`weight` are no longer replaced by an inferred text style, and a style is only inferred from a `role`. HTML imports used to get the body style on every text once a Design System was scanned. `style: null` opts out.
- Components with the same name are no longer picked silently: the one that has the requested variant wins, otherwise the new `AMBIGUOUS_COMPONENT` error lists the candidates. `component` also takes `{ id }` or `{ key }`; a key that isn't in the scan (a library component) is imported by key.
- `figma_import_html` swaps: layers are never hidden and fills never copied unless asked (`overrides: "none" | "text" | "match"`, default `"text"`; `fills`). An unknown variant is an error instead of a fallback to the default. Swaps take `id` or `key`.
- HTML import: `display: contents` wrappers no longer become frames with page-sized padding, and boxes whose CSS size is bigger than their content stay fixed instead of hugging.
- A plan root with `position: absolute` inside `target.parentId` keeps its x/y.

- Mode B analyzer: suggestions come in groups (`g1`, `g2`, …) that `figma_apply_transformations` can include (`groups`) or leave out (`excludeGroups`), and a one-off odd spacing variable (e.g. `item spacing/9`) is no longer suggested on an even spacing scale.
- HTML import mapped buttons to any component that merely looked like one (one text layer, 28–64px tall), e.g. an accordion. Automatic Design System mapping now needs a real role match from the name or description, skips private components (`_…`, `.…`), needs a text slot for the label and a similar height; skipped candidates are listed in the warnings. The Mode B analyzer uses the same check.
- HTML import: text with `line-height: normal` gets the rendered line height, so Figma's taller AUTO line height no longer shifts the layout.

- Sections created by Layerwright are white instead of the API's default dark grey.
- Componentize: padding is measured before Auto Layout is switched on (Figma moves the children at that moment), so a column's right padding mirrors its left one and text fills the card.
- A plan resolved against a stale scan no longer builds instances of a component that was deleted in the meantime.

## [0.1.4] - 2026-09-28

### Added
- `init` and the README now also show the Figma → code workflow ("Implement the selected Figma frame in code").
- docs/claude-prompt.md: a ready-to-paste prompt for CLAUDE.md, plus example requests.

## [0.1.3] - 2026-09-28

### Fixed
- HTML import: single-line labels (buttons, links, chips) no longer wrap in Figma. The label and its container now hug their text, so small differences between Figma's and Chrome's font metrics can't break the line.

### Added
- Demo GIF in the README.

## [0.1.2] - 2026-09-28

### Fixed
- README on npmjs.com: removed the demo GIF placeholder (it pointed at a file that doesn't exist yet), and links now work there too.

## [0.1.1] - 2026-09-28

### Fixed
- `npx layerwright …` did nothing. The CLI didn't recognise itself when started through npm's `.bin` symlink.
- The MCP server now exits and frees its port when Claude Code closes the connection, so a later session no longer fails with "port already in use".

## [0.1.0] - 2026-09-28

### Added
- **HTML to Figma import** (`import_html_to_plan`, `layerwright import`):
  - Playwright renders a file or folder (for example a Claude Design standalone HTML export) at 1440 and 390.
  - The rendered page is converted into an editable Design Plan: flexbox → Auto Layout, plus colours, borders, radii, shadows, gradients, fonts, RTL text, images and SVG icons.
  - Buttons, inputs and links map to scanned Design System components.
- Pixel-faithful importer (`figma_import_html`) with component variant sets, instance swaps and click actions; `figma_pages`; `figma_foundations` (variables and text styles).
- Design DSL: `fontFamily`, full weight scale, `italic`, `lineHeight`, `letterSpacing`, `direction: "rtl"`, `shadows`, `gradient`, `strokeWeights`, `opacity`, absolute `position`, `minWidth`/`maxWidth`, image `src` + `fit`, inline SVG icons.
- Font resolution against installed fonts ("Semi Bold" ≈ "SemiBold"), with an Inter fallback and a warning.
- `layerwright init` (one-command project setup) and `layerwright doctor` (diagnostics with fixes).
- Plugin UI states (connected, running, disconnected, last error), a remembered port, and setup help.
- An MCP server for Claude Code: Design System scan, task-scoped context, plan preview/execute/verify, Mode B audit and fixes, and design-to-code mapping and verification.

### Fixed
- The plugin no longer opens a duplicate connection after the port is changed.

[Unreleased]: https://github.com/shayan-m81/layerwright/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/shayan-m81/layerwright/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/shayan-m81/layerwright/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/shayan-m81/layerwright/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/shayan-m81/layerwright/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shayan-m81/layerwright/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shayan-m81/layerwright/releases/tag/v0.1.0
