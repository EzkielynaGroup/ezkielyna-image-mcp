# Ezkielyna Image MCP

An [MCP](https://modelcontextprotocol.io) server that lets your AI assistant **create and edit images from files on your computer**: Claude Desktop, Claude Code, Cursor, OpenCode, or any other MCP client that runs local stdio servers. Images are generated through the [Ezkielyna API](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-image-mcp).

Example: *"My product photo is `~/Shop/mug.jpg` and the logo is `~/Shop/logo.png`. Put the logo on the mug and save it as mug-logo."*

> 🇮🇩 Bahasa Indonesia: lihat [bagian di bawah](#bahasa-indonesia).

- **One file, no dependencies**: only Node.js 18 or newer. No `npm install` needed.
- Reference images come from local files (or https links); results are saved locally.
- Results can be edited again: the assistant just passes the previous result path.
- Paid calls are capped per session, the API key is never printed, and existing files are never overwritten.

> **npm package: not published yet.** Install from source as shown below. There is no `npx ezkielyna-image-mcp` for now.

## Requirements

1. **Node.js 18+** (`node -v`). Get the LTS from [nodejs.org](https://nodejs.org).
2. An **Ezkielyna API key in group Media** (the **Auto** group also includes image models). Buy API Credit at [ezkielyna.store](https://ezkielyna.store/beli-api-key?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-image-mcp) (from $0.5, QRIS/DANA/GoPay/USDT), redeem it under **Wallet** at [api.ezkielyna.store](https://api.ezkielyna.store), then create a key under **API Keys**. Standard/Premium keys cannot use image models.
3. Some balance. Prices per image are shown by the `list_image_models` tool and on [ezkielyna.store/models](https://ezkielyna.store/models?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-image-mcp).

## Install from source

```bash
git clone https://github.com/EzkielynaGroup/ezkielyna-image-mcp.git
cd ezkielyna-image-mcp
node --test test/        # optional: runs against a local mock, no network, no cost
pwd                      # the full path of ezkielyna-image-mcp.mjs is <this folder>/ezkielyna-image-mcp.mjs
```

On Windows, write paths in JSON with forward slashes (`C:/Users/you/ezkielyna-image-mcp/ezkielyna-image-mcp.mjs`) or double backslashes.

## Configuration (environment)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `EZKIELYNA_API_KEY` | yes | | key in group **Media** (or **Auto**) |
| `EZKIELYNA_BASE_URL` | no | `https://api.ezkielyna.store/v1` | API address |
| `EZKIELYNA_IMAGE_DIR` | no | `~/Pictures/Ezkielyna` | output folder (created if missing) |
| `EZKIELYNA_MAX_IMAGES` | no | `30` | paid images per session, a guard against runaway loops. Restart the app to reset. |
| `EZKIELYNA_TIMEOUT_MS` | no | `300000` | request timeout |

## Add it to your app

Replace `/path/to/ezkielyna-image-mcp.mjs` with your path and `sk-...` with your Media key.

**Claude Desktop**: Settings → Developer → Edit Config (`claude_desktop_config.json`), then fully quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "ezkielyna-image": {
      "command": "node",
      "args": ["/path/to/ezkielyna-image-mcp.mjs"],
      "env": { "EZKIELYNA_API_KEY": "sk-..." }
    }
  }
}
```

**Claude Code**

```bash
claude mcp add ezkielyna-image -e EZKIELYNA_API_KEY=sk-... -- node /path/to/ezkielyna-image-mcp.mjs
```

Add `--scope user` to make it available in every project. Check with `claude mcp list`.

**Cursor**: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), same JSON as Claude Desktop.

**OpenCode**: `opencode.json` in the project, or `~/.config/opencode/opencode.json` for all projects.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ezkielyna-image": {
      "type": "local",
      "command": ["node", "/path/to/ezkielyna-image-mcp.mjs"],
      "enabled": true,
      "environment": { "EZKIELYNA_API_KEY": "sk-..." }
    }
  }
}
```

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `generate_image` | New image from text. Options: `model` (default `gpt-image-2.5`), `size` (e.g. `1024x1024`), `filename`. | per image |
| `edit_image` | Edit or combine 1–4 images (local paths or https links). Options: `model`, `quality` (gpt-image only), `size`, `filename`. | per image |
| `list_image_models` | Image models your key can use, price per image, and which ones can edit. | free |

Edit models: `gpt-image-2.5` (default, up to 4 references, good for logos and backgrounds) and `nano-banana-pro` (up to 4 references, high detail, more expensive). Keep the total upload under ~30 MB (~22 MB for `nano-banana-pro`, which is sent as base64); resize large phone photos to about 2000 px JPEG first.

Each result includes the file path, model and price, and the image itself is shown inline when it is 3.5 MB or smaller.

## Security

- Reads only `.png`, `.jpg`, `.jpeg`, `.webp` files up to 20 MB whose content really is an image; links must be https.
- Writes only inside the output folder, sanitises file names and never overwrites (`name-1.png`, `name-2.png`, ...).
- The key is scrubbed from every answer and log line. Logs go to stderr; stdout carries only MCP messages.
- `EZKIELYNA_MAX_IMAGES` caps paid calls per session.

## Other providers

The server is built for the Ezkielyna API. `EZKIELYNA_BASE_URL` can point to another OpenAI-compatible endpoint that serves the same image model names through `/v1/images/generations` and `/v1/images/edits`, but per-image prices will not be shown there.

## Development

```bash
node --test test/
```

The tests spawn the server over stdio against a local mock gateway: no internet, no cost. Issues and pull requests are welcome.

---

## Bahasa Indonesia

Server MCP untuk **membuat dan mengedit gambar dari file di komputer** lewat asisten AI (Claude Desktop, Claude Code, Cursor, OpenCode). Contoh: *"Tempelkan logo `~/Toko/logo.png` ke foto `~/Toko/kaos.jpg` di dada kiri, simpan sebagai kaos-logo."*

- Cukup **Node.js 18+**, satu file, tanpa instal paket. **Paket npm belum dirilis**: pasang dari source (`git clone`, lihat di atas).
- Butuh **API key grup Media** (atau **Auto**) dari Ezkielyna API. Beli saldo mulai $0.5 lewat QRIS/DANA/GoPay: [ezkielyna.store/beli-api-key](https://ezkielyna.store/beli-api-key?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-image-mcp).
- Konfigurasi untuk tiap aplikasi sama seperti contoh di atas; ganti path file dan `sk-...`.
- Panduan lengkap berbahasa Indonesia: [ezkielyna.store/panduan/mcp-gambar](https://ezkielyna.store/panduan/mcp-gambar?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-image-mcp).

## License

MIT. Ezkielyna is an independent API gateway and is not affiliated with the model vendors or the MCP client makers.
