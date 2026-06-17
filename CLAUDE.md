# CLAUDE.md

This file provides guidance for Claude Code when working with this repository.

## Project Overview

**Kie Desktop** is an Electron-based desktop application that provides a playground for [kie.ai](https://kie.ai) models (an AI model aggregation platform). It is a fork of Fal Desktop (itself forked from WaveSpeed Desktop 2.1.8) with the API layer rewritten for kie.ai's task API. Personal-use app (no public distribution, no code signing/notarization, no auto-update).

Kept from upstream: Playground (multi-tab, batch mode), Models browser, Templates, History (local), Assets, all client-side Free Tools, i18n (en + zh-CN).

## kie.ai API Integration (src/api/)

- **`src/api/client.ts`** — `KieClient` (exported as `apiClient`):
  - `https://api.kie.ai` — tasks: `POST /api/v1/jobs/createTask` `{model, input}` → `{taskId}`; poll `GET /api/v1/jobs/recordInfo?taskId=` → `{state, resultJson, failMsg, progress, creditsConsumed}`; credits: `GET /api/v1/chat/credit` → number
  - `https://kieai.redpandaai.co` — upload: `POST /api/file-stream-upload` multipart `{file, uploadPath, fileName}` → `data.downloadUrl` (host `tempfile.redpandaai.co`; **files expire after ~3 days** — auto-save assets matters)
- Auth: `Authorization: Bearer {API_KEY}`.
- **kie error convention: HTTP is usually 200; the real status is `body.code`** — all responses go through `unwrap()`. 401 in body = invalid key.
- State mapping: `waiting`/`queuing`→`created`, `generating`→`processing`, `success`→`completed` (outputs parsed from the stringified `resultJson`, usually `{resultUrls:[…]}`), `fail`→`failed` (`failMsg`).
- Task ids are global — `getResult(taskId)` needs no model context (unlike fal).
- Rate limit: 20 new requests/10s → `RateLimiter` (18/10s) gates createTask (batch mode!).
- Not available (methods throw or no-op): cancel, server history (local-only), pricing, prompt optimization, delete tasks. **Credits balance IS available** and shown in Settings.
- **`src/api/registry-converter.ts`** — converts registry entries (OpenAPI schemas) into the internal `Model` shape for DynamicForm. Shared logic with the fal fork (anyOf flattening, File refs → uploaders, enum preference).

## Local Model Catalog

- **kie has no model-list/schema API.** Source of truth: docs.kie.ai — every page has a `.md` twin containing the full OpenAPI 3.0 YAML.
- Bundled registry: `src/data/kie-models.json` (~96 models scraped from all `/market/` pages; LLM chat models like Claude/GPT/Gemini are intentionally excluded — different protocol).
- Add/update models: `node scripts/add-model.mjs market/<page-slug>` or `--all` (re-scrapes the sitemap). The scraper extracts model ids from the `model` enum, prunes to the `input` schema + refs, and auto-skips pages without createTask or with required nested-object params.
- One docs page can declare multiple model ids (enum) → one registry entry each.
- No model thumbnails (kie docs have none) — except 2 hand-placed posters in `public/model-thumbs/` for the Featured panel.

## Android App (mobile/)

`mobile/` is a semi-standalone Capacitor sub-project that reuses the desktop `src/` via Vite aliases (`@` → `../src`, `@mobile` → `mobile/src`). It is a **trimmed build: Playground + Models + Settings only** (no free tools, no history/assets/templates pages).

- appId `android.imwalson.kie`, appName "Kie Ai" (`mobile/capacitor.config.ts`).
- Shares the same `KieClient` and bundled registry — and kie's API is CORS-permissive (echoes the `https://localhost` webview origin), so API calls work directly from the Android webview.
- Mobile-specific files: `mobile/src/App.tsx` (3 routes), `components/layout/{MobileLayout,MobileHeader,BottomNavigation}`, `pages/{MobileModelsPage,MobilePlaygroundPage,SettingsPage}` (SettingsPage is a minimal override aliased over the desktop one), `platform/index.ts` (Capacitor bridge: Filesystem asset save, CapacitorHttp download to bypass CORS, Share/Camera), `stores/predictionInputsStore.ts`.
- localStorage/asset keys rebranded to `kie_*` / `Documents/KieAi`.
- Build deps trimmed: no onnxruntime/transformers/ffmpeg/upscaler (those were free-tool only).

Build commands (run inside `mobile/`):
```bash
npm install
npm run build                 # vite web build → dist/
npx cap add android           # one-time: generate android/ native project
npm run android:build:debug   # build + sync + gradlew assembleDebug → app-debug.apk
```
Requires JDK 17 + Android SDK. `android/local.properties` (`sdk.dir=...`) is gitignored — created per machine. Native build outputs (`android/app/build/`, `.gradle/`) are gitignored; the `android/` source (Gradle scripts, manifest) is committed.

## Development Commands

```bash
npm run dev             # Electron + Vite dev (desktop)
npx vite                # Web-only dev server (desktop)
npm run build:mac:fast  # Unsigned mac build
cd mobile && npm run dev  # Mobile web dev server (test in browser at mobile viewport)
```

API key for testing in `.env` (`API_KEY=...`) — gitignored, never commit. The key is entered in-app via Settings (`kie.ai/api-key`).

## Conventions & Notes

- TypeScript strict; shadcn/ui; `cn()`; Zustand stores. Pre-commit prettier hook.
- CSP in `index.html` allowlists `api.kie.ai`, `*.kie.ai`, `kieai.redpandaai.co`, `*.redpandaai.co`.
- localStorage keys: `kie_api_key`, `kie_favorites`, `kie_theme`, `kie_language`, etc.
- Assets auto-save to `Documents/KieDesktop/` — critical given kie's 3-day file TTL.
- History is local-only (kie exposes no task-list API; web logs at kie.ai/logs).
- Balance card in Settings shows **credits** (integer), not USD.
- `.prettierignore` excludes the generated `src/data/kie-models.json`.
