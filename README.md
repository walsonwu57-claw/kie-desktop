# Kie Desktop

Personal desktop client for [kie.ai](https://kie.ai) models — a playground for running AI image/video generation with local-first history and assets, plus 12 fully client-side free creative tools (upscaler, background remover, face swapper, FFmpeg converters, and more).

Forked from Fal Desktop (itself forked from [WaveSpeed Desktop](https://github.com/WaveSpeedAI/wavespeed-desktop) v2.1.8) with the API layer rewritten for kie.ai's task API. Personal use only — not affiliated with kie.ai.

## Model catalog (bundled locally)

~96 generation models ship inside the app (`src/data/kie-models.json`), scraped from the OpenAPI specs embedded in [docs.kie.ai](https://docs.kie.ai) — kie has no model-list API. Catalog and form schemas load offline; only inference hits the kie API. LLM chat models (Claude/GPT/Gemini) are out of scope.

Add or refresh models:

```bash
node scripts/add-model.mjs market/google/nanobanana2   # one docs page
node scripts/add-model.mjs --all                        # re-scrape everything
```

## Setup

```bash
npm install
echo "API_KEY=your-kie-key" > .env   # get one at https://kie.ai/api-key
npm run dev                          # Electron dev with hot reload
```

The API key is entered in-app (Settings); the `.env` key is for development scripts only.

## Build (macOS, unsigned)

```bash
npm run build:mac:fast   # .app bundle in dist/, no signing/notarization
```

## Architecture notes

See [CLAUDE.md](CLAUDE.md) for the kie.ai protocol details (createTask/recordInfo, body-code errors, credits, upload TTL) and project conventions.
