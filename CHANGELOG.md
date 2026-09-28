# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/shayan-m81/layerwright/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/shayan-m81/layerwright/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shayan-m81/layerwright/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shayan-m81/layerwright/releases/tag/v0.1.0
