# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Another port than 7331 could never work: the plugin manifest only allowed `ws://localhost:7331`. It now allows 7331–7340, and the plugin window, `init --port` and the server refuse ports outside that range with a clear message. `doctor` also flags a plugin window that still runs an older build than the installed one.
- Text: explicit `fontSize`/`fontFamily`/`weight` are no longer replaced by an inferred text style, and a style is only inferred from a `role`. HTML imports used to get the body style on every text once a Design System was scanned. `style: null` opts out.
- Components with the same name are no longer picked silently: the one that has the requested variant wins, otherwise the new `AMBIGUOUS_COMPONENT` error lists the candidates. `component` also takes `{ id }` or `{ key }`; a key that isn't in the scan (a library component) is imported by key.
- `figma_import_html` swaps: layers are never hidden and fills never copied unless asked (`overrides: "none" | "text" | "match"`, default `"text"`; `fills`). An unknown variant is an error instead of a fallback to the default. Swaps take `id` or `key`.
- HTML import: `display: contents` wrappers no longer become frames with page-sized padding, and boxes whose CSS size is bigger than their content stay fixed instead of hugging.
- A plan root with `position: absolute` inside `target.parentId` keeps its x/y.

- HTML import mapped buttons to any component that merely looked like one (one text layer, 28–64px tall), e.g. an accordion. Automatic Design System mapping now needs a real role match from the name or description, skips private components (`_…`, `.…`), needs a text slot for the label and a similar height; skipped candidates are listed in the warnings. The Mode B analyzer uses the same check.
- HTML import: text with `line-height: normal` gets the rendered line height, so Figma's taller AUTO line height no longer shifts the layout.

- Sections created by Layerwright are white instead of the API's default dark grey.
- Componentize: padding is measured before Auto Layout is switched on (Figma moves the children at that moment), so a column's right padding mirrors its left one and text fills the card.
- A plan resolved against a stale scan no longer builds instances of a component that was deleted in the meantime.

### Added
- HTML import: text mixed with inline elements (`<b>`, `<span>`, `<a>`, `<br>`) is one text layer with styled ranges (weight, colour, size, links), in logical order for RTL, instead of many positioned layers. The DSL's `text` takes `runs`.
- HTML import: `mappings: [{ selector, component, variant?, props? }]` turns chosen elements into a component (`"$text"` = the element's text), ahead of automatic matching. `fontMap` replaces font families (also in `figma_import_html`).
- A font that's missing because the page only ships it as `.woff`/`.woff2` now says so and suggests installing a TTF/OTF or using `fontMap`. Missing-font warnings come once per family.
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

[Unreleased]: https://github.com/shayan-m81/layerwright/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/shayan-m81/layerwright/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/shayan-m81/layerwright/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/shayan-m81/layerwright/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shayan-m81/layerwright/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shayan-m81/layerwright/releases/tag/v0.1.0
