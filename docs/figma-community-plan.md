# Figma Community plan

Status: **plan only, not submitted.** This covers what it takes to list the Layerwright plugin on the Figma
Community, what has to change in the code first, the listing copy, the risks, and the launch.

Sources: the [plugin manifest docs](https://developers.figma.com/docs/plugins/manifest/), [Publish plugins to the Figma Community](https://help.figma.com/hc/en-us/articles/360042293394-Publish-plugins-to-the-Figma-Community), the [plugin review guidelines](https://help.figma.com/hc/en-us/articles/360039958914) and the [Figma brand guidelines](https://www.figma.com/using-the-figma-brand/). Re-read them before submitting, because they change.

## 1. Review requirements and how we meet them

| Requirement | How we meet it |
|---|---|
| Works as described and is free of bugs | The strict mock test suite plus the real-Figma checklist in §7, run on macOS and Windows before submitting |
| The name must not use Figma's brand ("Figma", "Fig", the logo, look-alike icons) | Name "Layerwright"; "for Figma" appears only in the description. The icon is our own mark, not a Figma shape |
| Must not imply an official product (Figma or Anthropic) | The description says "works with Claude Code", and the disclaimer appears in the description and the README |
| Support contact | GitHub Issues: `https://github.com/shayan-m81/layerwright/issues`. Do **not** use a work email |
| Network access declared, with reasoning | The manifest `networkAccess` below. The listing shows it automatically |
| Security disclosure form | The answers are in §4 (no data collection, local only) |
| Two-factor authentication on the publishing account | Enable it on the Figma account before submitting |
| Accurate listing (the description matches behaviour, no misleading screenshots) | Real screenshots from the demo file; the requirements are stated in the first paragraph |
| No API misuse or data exfiltration | The plugin only relays to localhost; there are no remote calls, analytics or eval |

## 2. Technical changes before submitting

### 2.1 Manifest `networkAccess` (required)

The published manifest can't rely on `devAllowedDomains`, because that list only applies while the plugin is
imported for development. The manifest docs say `allowedDomains` takes `ws://` patterns with ports, and that
*"reasoning is required if your allowedDomains list includes "*" or includes local or development servers."*
So the published manifest lists the local server explicitly **and** gives a reason:

```json
"networkAccess": {
  "allowedDomains": ["ws://localhost:7331", "ws://localhost:7332", "ws://localhost:7333", "ws://localhost:7334", "ws://localhost:7335"],
  "reasoning": "Layerwright connects only to its companion server running on your own computer (ws://localhost), which Claude Code starts. It never contacts the internet: designs, files and images stay on your machine."
}
```

Code changes that go with it:
- The plugin UI currently accepts any port from 1024 to 65535. For the published build, **limit it to 7331–7335** (the listed ports) and show a clear message for other ports. Add a test.
- `doctor` and `init --port` must refuse ports outside 7331–7335 (or warn when `LAYERWRIGHT_PORT` is out of range).
- Keep `devAllowedDomains` for local development builds (it's ignored in published use).
- Remove `"id": "layerwright-local"`. Figma assigns the published plugin ID on first publish, and it then goes into `manifest.json`. Keep a separate dev manifest (`manifest.dev.json`) for contributors.
- Review `permissions`: `teamlibrary` (the scan reads enabled library variables) and `currentuser` (hello shows the user's name). Drop `currentuser` if it isn't needed; fewer permissions make review easier.

### 2.2 Onboarding for users without the local server

Most people who find the plugin in the Community won't have the server installed. The plugin UI needs to say so, so it doesn't just look broken:
- **First run / disconnected state:** "Layerwright needs its free companion app. 1) Install Node 20+ 2) run `npx layerwright init` in your project 3) open Claude Code." Add a **Copy command** button and a "Setup guide" link that opens the README with `figma.openExternal` (allowed without network access).
- A **Retry** button and the current port, with the ports limited to 7331–7335.
- After 3 failed attempts, show the troubleshooting link.
- Make the window larger (about 320 × 260) for the first-run content, and shrink it once connected.
- Nothing is sent anywhere while disconnected.

### 2.3 Assets

| Asset | Size | Notes |
|---|---|---|
| Plugin icon | 128 × 128 px PNG | Our mark (tag + ribbon), on a solid background. No Figma shapes |
| Thumbnail / cover | 1920 × 1080 px | "HTML → editable Figma" before/after, with the name and tagline |
| Carousel | up to 9 images/videos, 1920 × 1080 recommended | See the shot list in §3.4 |
| Playground file (optional) | — | A Community file with a sample Design System plus the imported demo |

## 3. Listing copy

### 3.1 Name and tagline
- **Name:** Layerwright
- **Tagline:** Turn HTML and Claude Code designs into editable Figma frames, locally.

### 3.2 Description

> Layerwright imports HTML, including Claude Design's standalone HTML export, into native, editable
> Figma frames. Flexbox becomes Auto Layout, and text, colours, shadows, images and icons come across
> as real layers. It also lets Claude Code build new screens from your own Design System's components,
> variables and text styles.
>
> **Requires the free Layerwright companion app** (Node.js 20+), which runs on your computer:
> `npx layerwright init`. The plugin talks only to that app on `localhost`. It never uploads anything.
> Setup: github.com/shayan-m81/layerwright
>
> • HTML to Figma with Auto Layout, desktop and mobile
> • Buttons, inputs and links become your DS components
> • RTL support (Persian, Arabic, Hebrew)
> • One undo step per run, automatic rollback, no API keys
>
> Open source (MIT). Works with Claude Code. Not affiliated with, endorsed or sponsored by Anthropic or
> Figma. Claude is a trademark of Anthropic.

### 3.3 Tags and category
- Category: Design tools / Import & export
- Tags: html to figma, import, auto layout, design system, mcp, claude code, ai, code to design, rtl

### 3.4 Screenshot / GIF shot list
1. Cover: an HTML page in a browser → the same page as Figma frames, with the layer panel showing Auto Layout.
2. The "Import ./design.html into Figma" prompt in Claude Code and the result appearing (GIF, about 10 s).
3. Desktop 1440 and mobile 390 screens side by side.
4. Design System mapping: an imported button selected, and the panel showing an instance of *your* Button.
5. An RTL Persian page imported with the text right-aligned.
6. The plugin window states: connected, running, and the first-run setup.
7. Mode B: an audit summary, and hard-coded colours bound to variables.
8. The undo story: one Cmd+Z removes the whole import.
9. `npx layerwright doctor` output with every check passing.

### 3.5 FAQ answers (for the listing and the forum)
- **Why do I need a companion app?** Figma plugins can't run a browser engine or talk to Claude Code. The app renders the HTML and turns it into a plan, and the plugin builds it. Both run on your machine.
- **Is my design uploaded anywhere?** No. There are no servers, no accounts and no analytics. The code is open source.
- **Do I need Claude?** The HTML import runs from the command line (`npx layerwright import`) and from any MCP client. The design-from-prompt features use Claude Code.
- **Why "localhost" in network access?** That's the companion app on your own computer. See the manifest reasoning.
- **Windows?** Yes, with Node 20+ and Figma desktop.

## 4. Security disclosure answers (draft)

- Does the plugin collect, store or transmit user data? **No.** It relays requests between the Figma document and a local process on the same computer.
- Network access: **restricted** to `ws://localhost:7331–7335`.
- Third-party services, analytics or tracking: **none.**
- Authentication or stored credentials: **none.** `clientStorage` holds only the chosen port number.
- Is the source code available? **Yes**, under the MIT licence.

## 5. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Users without Claude Code or Node install it and see "disconnected" | 1-star reviews, reports of it being "broken" | Put the requirement in the first line of the tagline/description, add the first-run onboarding (§2.2) and the Copy command button, and document CLI-only use (`npx layerwright import`) |
| The reviewer can't test without the local server | Rejection as "doesn't work" | Include reviewer notes with exact steps, a 2-minute video, and the playground file. Offer a demo that needs no Claude: `npx layerwright init`, then `import` a bundled sample |
| Localhost in `allowedDomains` gets extra scrutiny | Delay or rejection | Clear `reasoning`, a fixed port list rather than a wildcard, and open-source links to `ui.html` showing the only socket |
| Name or branding seen as implying Figma or Anthropic | Rejection | No "Figma"/"Fig" in the name, our own icon, descriptive "works with Claude Code", and the disclaimer |
| Missing fonts make imports look off | Poor first impression | Warnings name the missing font; the troubleshooting doc covers installing TTF/OTF |
| Plugin API changes | Breakage | Pin `@figma/plugin-typings`, CI, and a strict mock that encodes the API rules |
| Localhost port conflicts with other tools | Connection failures | 5 ports, `doctor` shows who owns the port, and the port is saved per user |

## 6. Submission checklist

1. [ ] Enable 2FA on the Figma account that will own the plugin.
2. [ ] Make the manifest changes in §2.1 (allowedDomains + reasoning, drop the dev `id`, review permissions) and limit the UI port range, with tests.
3. [ ] Build the onboarding UI (§2.2), including Copy command, Setup guide (`figma.openExternal`) and Retry.
4. [ ] Run the real-Figma test checklist (§7) on macOS and Windows with the published manifest settings.
5. [ ] Create the icon (128 × 128), cover (1920 × 1080) and carousel (§3.4). Record the demo video.
6. [ ] Publish npm `layerwright` so that `npx layerwright init` works for reviewers.
7. [ ] Create the playground Community file (a sample DS and an imported demo).
8. [ ] In Figma desktop: Plugins → Manage plugins → Layerwright → **Publish**. Fill in the name, tagline, description (§3.2), category, tags, support contact (GitHub Issues), assets and the security disclosure (§4).
9. [ ] Add reviewer notes: requirements, 5 setup steps, and a link to the video.
10. [ ] Submit. Watch email for reviewer questions and answer within 24 hours.
11. [ ] After approval, write the assigned plugin ID into `manifest.json`, tag a release, and update the README with the Community link.

## 7. Real-Figma test checklist (before submitting and before every release)

- [ ] Import the plugin from `~/.layerwright/figma-plugin/manifest.json`. The UI shows Connected within 2 s of Claude Code starting.
- [ ] `import_html_to_plan` on `packages/html-import/test/fixtures/landing.html` → execute → frames at 1440 and 390, the nav uses horizontal Auto Layout with space-between, the cards have shadows and the gradient hero renders.
- [ ] `rtl-fa.html` with Vazirmatn installed: the text is right-aligned, the header's first item is on the right, and there's no font warning. Uninstall the font and check for the Inter fallback plus a warning.
- [ ] A Claude Design standalone HTML export (a folder) imports without errors.
- [ ] Image `src` over https (PNG) shows the image; a WebP URL shows a placeholder plus a warning.
- [ ] An inline SVG icon with `color` is recoloured.
- [ ] A DS scan in a file with Button/Input components, then importing `login.html`, produces instances.
- [ ] One Cmd+Z removes a whole import. A forced failure (a component deleted after the scan) rolls back completely.
- [ ] Changing the port in the plugin reconnects exactly once, and the port is remembered after reopening.
- [ ] Closing and reopening Claude Code: the plugin reconnects on its own.
- [ ] `npx layerwright doctor` reports everything as passing while connected, and each failure while disconnected.

## 8. Launch plan

**Day 0 (the listing is approved):** release v0.x with the Community link, and pin a GitHub Discussion called "Show your imports".

| Channel | Post |
|---|---|
| r/FigmaDesign | "I built an open-source HTML → editable Figma importer (Auto Layout, your DS components)". Include the GIF and the setup; ask for feedback, not votes |
| r/ClaudeAI | "Claude Design → Figma: finally an export path". Demo of the Claude Code workflow; note that it's unofficial |
| X / Twitter | A 30 s video thread: problem → one command → editable frames → DS mapping → RTL. Tag it #ClaudeCode #Figma #MCP |
| Product Hunt | Launch on a Tuesday–Thursday with the tagline, the cover, 4 carousel shots and a maker comment explaining that it's local-first |
| Figma Forum | A post in "Share your work / Plugins" with a short write-up and the playground file |
| Hacker News | A Show HN about the deterministic DSL/executor architecture (the technical angle) |

**After launch:** triage issues within 48 hours, collect failing HTML samples as fixtures, and publish a changelog every two weeks.

### Demo video script (about 60 s)
1. (0–5 s) A browser shows a Claude Design page. Caption: "Claude Design can't export to Figma…"
2. (5–15 s) The terminal: `npx layerwright init`, and the three next steps appear.
3. (15–25 s) Figma: import the plugin, run it, and it shows "Connected to Claude".
4. (25–40 s) Claude Code: "Import ./design.html into Figma". The plan summary appears, then the frames appear on the canvas.
5. (40–50 s) Click into the layers: Auto Layout, text, and a button that is an instance of the DS Button.
6. (50–57 s) The mobile frame beside it, and an RTL page.
7. (57–60 s) End card: "Layerwright: open source, local, free. github.com/shayan-m81/layerwright". Show the disclaimer in small text.
