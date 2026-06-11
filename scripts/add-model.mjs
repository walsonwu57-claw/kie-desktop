#!/usr/bin/env node
/**
 * Add kie.ai models to the local bundled registry (src/data/kie-models.json).
 *
 * kie has no model-list/schema API; docs.kie.ai serves every model page as
 * markdown containing the full OpenAPI 3.0 spec — that is our schema source.
 *
 * Usage:
 *   node scripts/add-model.mjs market/google/nanobanana2   # one docs page slug
 *   node scripts/add-model.mjs --all                       # every /market/ page in the sitemap
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = resolve(ROOT, "src/data/kie-models.json");
const DOCS_BASE = "https://docs.kie.ai";
const CREATE_TASK_PATH = "/api/v1/jobs/createTask";

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

/** All English /market/ model-page slugs from the sitemap. */
async function listMarketSlugs() {
  const xml = await fetchText(`${DOCS_BASE}/sitemap.xml`);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return locs
    .filter((u) => u.includes("/market/"))
    .filter((u) => !u.includes("/cn/"))
    .filter((u) => !/quickstart|\/common\b|\/common\//.test(u))
    .map((u) => u.replace(`${DOCS_BASE}/`, ""));
}

/** Extract the fenced YAML OpenAPI block from a docs .md page. */
function extractOpenApiYaml(md) {
  const m = md.match(/```ya?ml\n([\s\S]*?)\n```/);
  return m ? m[1] : null;
}

/** Derive a coarse category from the OpenAPI tags + model id. */
function deriveCategory(tags, modelId) {
  const id = modelId.toLowerCase();
  for (const pat of [
    "text-to-image",
    "image-to-image",
    "text-to-video",
    "image-to-video",
    "video-to-video",
    "text-to-music",
    "text-to-speech",
  ]) {
    if (id.includes(pat)) return pat;
  }
  const tag = (tags?.[0] ?? "").toLowerCase();
  if (tag.includes("video")) return "video";
  if (tag.includes("image")) return "image";
  if (tag.includes("music") || tag.includes("audio")) return "audio";
  return "other";
}

/**
 * Parse one docs page into registry entries.
 * A page may declare several model ids in the `model` enum — one entry each.
 */
function pageToEntries(slug, md) {
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const pageTitle = titleMatch ? titleMatch[1].trim() : slug;

  const yamlSrc = extractOpenApiYaml(md);
  if (!yamlSrc) {
    console.warn(`  SKIP ${slug} (no OpenAPI block)`);
    return [];
  }
  let doc;
  try {
    doc = yaml.load(yamlSrc);
  } catch (err) {
    console.warn(`  SKIP ${slug} (YAML parse failed: ${err.message})`);
    return [];
  }

  const post = doc?.paths?.[CREATE_TASK_PATH]?.post;
  if (!post) {
    const paths = Object.keys(doc?.paths ?? {});
    console.warn(
      `  SKIP ${slug} (not a createTask model; paths: ${paths.join(",") || "none"})`,
    );
    return [];
  }

  let body = post.requestBody?.content?.["application/json"]?.schema;
  const components = doc.components?.schemas ?? {};
  if (body?.$ref) {
    body = components[body.$ref.split("/").pop()] ?? body;
  }
  const modelProp = body?.properties?.model;
  const inputProp = body?.properties?.input;
  if (!inputProp) {
    console.warn(`  SKIP ${slug} (no input schema in request body)`);
    return [];
  }
  let input = inputProp;
  if (input.$ref) {
    input = components[input.$ref.split("/").pop()] ?? input;
  }
  if (!input.properties) {
    console.warn(`  SKIP ${slug} (input schema has no properties)`);
    return [];
  }

  // Reject models whose REQUIRED params are nested objects the form can't render
  for (const name of input.required ?? []) {
    const p = input.properties[name];
    const refName = p?.$ref?.split("/").pop();
    const refd = refName ? components[refName] : undefined;
    const target = refd ?? p;
    const isFileLike = "url" in (target?.properties ?? {});
    if (target?.properties && !isFileLike && target.type !== "string") {
      console.warn(`  SKIP ${slug} (required nested object "${name}")`);
      return [];
    }
  }

  const modelIds = modelProp?.enum ?? [];
  if (modelIds.length === 0) {
    console.warn(`  SKIP ${slug} (no model id enum)`);
    return [];
  }

  const description = (post.description ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l && !l.startsWith("#") && !l.startsWith("<") && !l.startsWith(":::"),
    )
    .slice(0, 2)
    .join(" ")
    .slice(0, 200);

  // Keep components referenced by the input schema so $refs resolve
  const keptComponents = {};
  const yamlStr = JSON.stringify(input);
  for (const [name, schema] of Object.entries(components)) {
    if (yamlStr.includes(`#/components/schemas/${name}`)) {
      keptComponents[name] = schema;
    }
  }

  return modelIds.map((modelId) => ({
    endpoint_id: modelId,
    metadata: {
      display_name:
        modelIds.length > 1 ? `${pageTitle} (${modelId})` : pageTitle,
      category: deriveCategory(post.tags, modelId),
      description,
      docs_url: `${DOCS_BASE}/${slug}`,
    },
    openapi: {
      components: { schemas: { KieInput: input, ...keptComponents } },
    },
  }));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "Usage: node scripts/add-model.mjs <docs-page-slug...> | --all",
    );
    process.exit(1);
  }

  let slugs;
  if (args.includes("--all")) {
    console.log("Listing /market/ pages from docs sitemap...");
    slugs = await listMarketSlugs();
    console.log(`  ${slugs.length} pages`);
  } else {
    slugs = args.map((a) =>
      a.replace(/^https?:\/\/docs\.kie\.ai\//, "").replace(/\.md$/, ""),
    );
  }

  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  let registry = [];
  if (existsSync(REGISTRY_PATH)) {
    registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  }
  const byId = new Map(registry.map((e) => [e.endpoint_id, e]));

  let added = 0,
    updated = 0,
    pages = 0;
  const POOL = 6;
  for (let i = 0; i < slugs.length; i += POOL) {
    const chunk = slugs.slice(i, i + POOL);
    const results = await Promise.all(
      chunk.map(async (slug) => {
        try {
          const md = await fetchText(`${DOCS_BASE}/${slug}.md`);
          return pageToEntries(slug, md);
        } catch (err) {
          console.warn(`  SKIP ${slug} (${err.message})`);
          return [];
        }
      }),
    );
    for (const entries of results) {
      pages++;
      for (const entry of entries) {
        if (byId.has(entry.endpoint_id)) {
          const idx = registry.findIndex(
            (e) => e.endpoint_id === entry.endpoint_id,
          );
          registry[idx] = entry;
          updated++;
        } else {
          registry.push(entry);
          byId.set(entry.endpoint_id, entry);
          added++;
        }
      }
    }
    process.stdout.write(
      `\r  pages ${Math.min(i + POOL, slugs.length)}/${slugs.length}`,
    );
  }
  process.stdout.write("\n");

  writeFileSync(REGISTRY_PATH, JSON.stringify(registry) + "\n");
  const kb = Math.round(Buffer.byteLength(JSON.stringify(registry)) / 1024);
  console.log(
    `Done: ${added} added, ${updated} updated from ${pages} pages. Registry: ${registry.length} models, ${kb} KB → ${REGISTRY_PATH}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
