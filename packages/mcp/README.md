# logolab

**Turn an image into a clean SVG and a complete app-icon set — from your coding agent, on your machine.**

An [MCP](https://modelcontextprotocol.io) server wrapping the vectorizer and icon
exporter from [LogoLab](https://github.com/Blaxzter/LogoLab). A model generates a
1024px PNG with soft edges and a JPEG-ish halo; something has to turn that into a
favicon that is still legible at 16px. Doing it by hand means a raster upscale and
a blurry icon. This runs a real trace — region segmentation and curve fitting, not
an image embed — so the result scales.

Nothing is uploaded. It is a stdio server: your agent starts it as a child
process, it reads and writes files on your disk, and it never opens a socket.

## Install

```bash
claude mcp add logolab -- npx -y logolab       # Claude Code
```

Or let it write the config itself, in whichever project should get the icons:

```bash
npx -y logolab install                   # .mcp.json here (Claude Code)
npx -y logolab install --scope user      # every project
npx -y logolab install --client cursor   # .cursor/mcp.json
npx -y logolab install --client vscode   # .vscode/mcp.json
npx -y logolab install --client print    # print the JSON, change nothing
```

Any other client wants the usual three facts:

```json
{ "mcpServers": { "logolab": { "command": "npx", "args": ["-y", "logolab"] } } }
```

Then ask your agent: *"trace icon.png and export a PWA icon set into public/"*.

## Tools

| Tool | What it does |
| --- | --- |
| `make_app_icons` | image → traced SVG → a full icon set. The one call that does the job. |
| `trace_icon` | just the vectorization: a clean, editable SVG. |
| `export_icons` | an existing SVG/PNG → PWA, favicon, Tauri, Electron, Android, iOS or extension icons. |
| `split_icon_sheet` | a grid of icons on one canvas → one traced SVG per icon. |
| `inspect_icon` | what the tracer would decide, before it runs. |

Presets: `pwa`, `favicon`, `web`, `tauri`, `electron`, `android`, `ios`, `extension`.

## Try it without a client

```bash
npx -y logolab try ./icon.png ./out
```

## Notes

- **Node ≥ 22.18** is required.
- **WebP inputs** need the optional `sharp` decoder, which is an *optional peer*
  and is not installed by default — it pulls a platform-specific libvips binary
  that dwarfs the rest of the server. Run `npm install sharp` if you need it, or
  convert to PNG. Every other format (PNG, JPEG, GIF, BMP, SVG) works out of the box.
- Relative paths in a tool call resolve against **your agent's working directory**,
  not this package — so `./public/` means the project you are working on.

MIT © Frederic Abraham
