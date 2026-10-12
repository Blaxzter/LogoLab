// The agent SKILL (agentskills.io format: a SKILL.md with `name` + `description`
// frontmatter) — LogoLab for an agent that reads skills instead of, or as well as,
// talking MCP. It drives the same tools through `logolab call`, so nothing here
// restates a schema: inputs are read from `logolab tools <name>`.
//
// This string is the source. `plugins/logolab/skills/logolab/SKILL.md` (the Claude
// Code plugin) is a copy, regenerated with
//
//   node --experimental-strip-types src/mcp/server.ts skill > plugins/logolab/skills/logolab/SKILL.md
//
// and `test/mcp-skill.test.ts` fails when the two differ. `logolab install --skill`
// writes this string too, so the published package carries it without a data file.

/** How the skill runs the CLI. `@latest`: an npx cache from before `call` existed must not win. */
export const SKILL_CLI = 'npx -y logolab@latest'

export const SKILL_MD = `---
name: logolab
description: Turn an image into a clean SVG and app icons, locally. Use when an icon, logo or generated PNG must become a vector (trace / vectorize / "make this an SVG"), when a project needs a favicon or a PWA, Tauri, Electron, Android, iOS or browser-extension icon set, or when one image holds a grid of many icons (a contact sheet) that should become one SVG each. Also traces line art as real strokes.
---

# LogoLab: image → clean SVG → icon set

LogoLab is a real vectorizer (region segmentation and curve fitting, not an image
embedded in an SVG) plus an icon exporter. It runs on this machine through npx; nothing
is uploaded. Every command below prints a one-paragraph summary followed by a \`\`\`json
block with the details (paths written, node counts, the decisions it made).

Run tools with:

\`\`\`
${SKILL_CLI} call <tool> key=value key=value …
\`\`\`

Values are read as JSON when they parse (\`strokes=true\`, \`normalize=24\`) and as plain
strings otherwise (\`image=logo.png\`). A comma list is an array (\`presets=pwa,favicon\`).
**Single-quote any value with braces, brackets or spaces** — bash brace-expands
\`{…}\` and PowerShell will not parse it: \`'grid={"rows":3,"cols":4}'\` (bare keys like
\`'grid={rows:3,cols:4}'\` work too). For a long or nested input, write the arguments to a
JSON file and pass \`@args.json\` instead of key=value pairs. Relative paths resolve against the current
directory. Needs Node ≥ 22.18; the first run downloads the package.

## Pick the tool

| The user wants… | Tool |
| --- | --- |
| icons for an app from one image (favicon, PWA, Tauri, Android, iOS …) | \`make_app_icons\` |
| just the SVG | \`trace_icon\` |
| icons from an SVG or a final PNG that should NOT be re-traced | \`export_icons\` |
| one image holding MANY icons in a grid → one SVG each | \`split_icon_sheet\` |
| to know what the tracer will do before it runs (fast) | \`inspect_icon\` |

Every input of a tool, with its default and meaning: \`${SKILL_CLI} tools <tool>\`.
Read it before reaching for an option not shown here.

## Common calls

\`\`\`
# the whole job: trace, then a PWA set (writes public/… under outDir, so outDir is the project root)
${SKILL_CLI} call make_app_icons image=icon.png outDir=. presets=pwa,favicon appName="My App"

# just the vector, next to the source (icon.svg)
${SKILL_CLI} call trace_icon image=icon.png

# an icon SET: icons that take the CSS text colour on a shared 24-unit grid
${SKILL_CLI} call split_icon_sheet sheet=sheet.png outDir=src/icons 'grid={"rows":3,"cols":4}' ink=currentColor normalize=24 names=home,search,settings

# line art as stroked paths (adjustable stroke-width) instead of filled outlines
${SKILL_CLI} call trace_icon image=sketch.png strokes=true
\`\`\`

Presets: \`pwa\`, \`favicon\`, \`web\`, \`tauri\` (writes src-tauri/icons), \`electron\`,
\`android\`, \`ios\`, \`extension\`. Each preset writes its platform's own layout UNDER
\`outDir\` (\`public/icons/…\`, \`src-tauri/icons/…\`, \`res/mipmap-*/…\`), so \`outDir\` is
the project root — not \`public/\`, or you get \`public/public/\`. The exceptions are the
native ones: \`android\` writes \`res/…\`, so its \`outDir\` is \`app/src/main\`, and \`ios\`
writes \`AppIcon.appiconset/\`, so its \`outDir\` is the \`Assets.xcassets\` folder. If the project serves
static files from somewhere else, export to a scratch folder and move the files.

Pass \`appName\` (from package.json, the page title, or ask): the web manifest is written
with it and says "App" without it.

### Brand colours: two kinds of icon in one export

Favicons and the "any" PWA icons are drawn on whatever is behind them, so they stay
transparent (\`appearance.background\`, default \`transparent\`). Some icons can't be
transparent: apple-touch (iOS draws alpha as black), the maskable pair (Android crops it
to a shape), the iOS set, the Play icon and the adaptive foreground. Those take
\`appearance.opaque\`. Give it the brand's background colour (from the CSS, the existing
manifest, or ask), and give the manifest the same colours:

\`\`\`
${SKILL_CLI} call export_icons image=logo.svg outDir=. presets=pwa 'appearance={"opaque":{"background":"#f3ece0","paddingPct":12}}' themeColor=#f3ece0
\`\`\`

- \`opaque.paddingPct\` pads only those icons. Maskable raises it to its own safe-zone
  floor anyway.
- \`themeColor\` / \`backgroundColor\` / \`startUrl\` go into \`manifest.webmanifest\` and the
  \`<head>\` snippet. Both colours default to the opaque fill. Pass \`startUrl\` when the
  app is not served from \`/\`.
- Without a colour, LogoLab picks one: the logo's own background if it has one, otherwise
  white or black for contrast. The reply's "Opaque icons … filled #…" line says which.
  If it was picked, check it fits the brand.
- \`background=<colour>\` puts a card behind EVERY icon, favicons included. Use it only
  when that is the look you want.
- A "Note: … see-through" line means the art has an enclosed transparent area (a window
  left unfilled), which shows the taskbar or wallpaper through the icon. Tell the user;
  it is fine for a ring or a letter's counter, wrong when that area should be white.

After an export:

- \`head-snippet.html\` (pwa / favicon) holds the \`<link>\` tags: put them in the app's
  \`<head>\` (index.html, the root layout …) and delete the snippet file.
- \`logolab-icons.md\` lists what was written and why; read it, then delete it or keep it
  as the user prefers.
- A file reported \`"replaced": true\` overwrote one that existed. Say so. A hand-written
  \`manifest.webmanifest\` is worth exporting elsewhere and merging by hand.

## Judging the result

- The tracer picks colour vs mono, gradients and resolution itself, and says what it chose
  in the summary. Trust the defaults first; override only for a reason you can name.
- **One-ink line art** (an outline icon, a sketch, a diagram): \`strokes=true\` gives stroked
  paths. \`strokesOnly=true\` with it forbids filled shapes entirely (dots become round
  strokes) — for plotters or stroke-only icon sets.
- **Mono icons for a set**: \`ink=currentColor\` so CSS colours them, \`normalize=24\` so they
  share a viewBox.
- **Too many nodes / wobbly edges**: raise \`smoothing\` (default 50). **Lost detail**: lower
  it, or \`detail=high\`. **Stray specks**: raise \`despeckle\` (default 25).
- **A background box you did not want**: \`removeBackground=true\`.
- Look at the written SVG (render it or open it) before telling the user it is done; the
  JSON's node count is a quick sanity check — a simple glyph in thousands of nodes means a
  wrong mode or a noisy source.
- WebP input needs the optional \`sharp\` package (\`npm install sharp\`); otherwise convert
  to PNG first. PNG, JPEG, GIF, BMP and SVG work as they are.

A command exits non-zero and prints \`LogoLab: <reason>\` when a call fails; the reason
names the input that was wrong.
`
