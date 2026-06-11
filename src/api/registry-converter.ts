/**
 * Converts registry model entries (OpenAPI 3.0 schema, scraped from docs.kie.ai)
 * into the internal `Model` shape consumed by DynamicForm / schemaToForm.
 *
 * The UI reads: model.api_schema.api_schemas[].request_schema where
 * type === "model_run", with { properties, required, "x-order-properties" }.
 */
import type { Model, SchemaProperty } from "@/types/model";

export interface RegistryEntry {
  endpoint_id: string;
  metadata?: {
    display_name?: string;
    category?: string;
    description?: string;
    status?: string;
    thumbnail_url?: string;
    model_url?: string;
    updated_at?: string;
  };
  openapi?: RegistryOpenApi | { error?: unknown };
}

interface RegistryOpenApi {
  components?: {
    schemas?: Record<string, RegistrySchemaObject>;
  };
}

interface RegistrySchemaObject {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  properties?: Record<string, RegistrySchemaObject>;
  required?: string[];
  items?: RegistrySchemaObject;
  anyOf?: RegistrySchemaObject[];
  allOf?: RegistrySchemaObject[];
  $ref?: string;
  examples?: unknown[];
  "x-fal-order-properties"?: string[];
}

/** Input params that are API plumbing, not user-facing controls. */
const HIDDEN_FIELDS = new Set(["end_user_id", "sync_mode"]);

/** Schema names that represent uploaded-file objects in the schemas. */
const FILE_SCHEMA_RE = /(^|\/)(File|ImageFile|VideoFile|AudioFile)$/;

function resolveRef(
  schema: RegistrySchemaObject,
  all: Record<string, RegistrySchemaObject>,
): { schema: RegistrySchemaObject; isFile: boolean } {
  if (schema.$ref) {
    const isFile = FILE_SCHEMA_RE.test(schema.$ref);
    const name = schema.$ref.split("/").pop() ?? "";
    return { schema: all[name] ?? {}, isFile };
  }
  return { schema, isFile: false };
}

/** Flatten anyOf/allOf/$ref into a single SchemaProperty the form layer understands. */
function convertProperty(
  raw: RegistrySchemaObject,
  all: Record<string, RegistrySchemaObject>,
): SchemaProperty {
  let src = raw;
  let nullable = false;
  let isFile = false;

  const resolved = resolveRef(raw, all);
  if (raw.$ref) {
    src = { ...resolved.schema, ...raw, $ref: undefined };
    isFile = resolved.isFile;
  }

  const variants = src.anyOf ?? src.allOf;
  if (variants && variants.length > 0) {
    nullable = variants.some((v) => v.type === "null");
    const nonNull = variants.filter((v) => v.type !== "null");
    // Prefer a string-enum variant (e.g. image_size presets over the
    // {width,height} object form), then plain string, then whatever is first.
    const pick =
      nonNull.find((v) => v.type === "string" && v.enum) ??
      nonNull.find((v) => v.type === "string") ??
      nonNull[0];
    if (pick) {
      const r = resolveRef(pick, all);
      isFile = isFile || r.isFile;
      // Top-level keys (description/title/default) win over the variant's
      src = { ...r.schema, ...src, anyOf: undefined, allOf: undefined };
      src.type = r.schema.type ?? pick.type;
      src.enum = src.enum ?? pick.enum ?? r.schema.enum;
      src.minimum = src.minimum ?? pick.minimum;
      src.maximum = src.maximum ?? pick.maximum;
      // An object default (e.g. {width,height}) can't seed an enum select
      if (
        src.type === "string" &&
        src.default !== undefined &&
        typeof src.default !== "string"
      ) {
        src.default = undefined;
      }
    }
  }

  const prop: SchemaProperty = {
    type: isFile ? "string" : (src.type ?? "string"),
    title: src.title,
    description: src.description,
    default: src.default,
    minimum: src.minimum,
    maximum: src.maximum,
    enum: src.enum,
    nullable,
  };

  // File-typed inputs (image_url etc.) → uploader; URLs come from storage upload
  if (isFile) {
    prop["x-ui-component"] = "uploader";
  }

  // Arrays: convert item type (arrays of files → uploaders)
  if (src.type === "array" && src.items) {
    const item = resolveRef(src.items, all);
    if (item.isFile) {
      prop.type = "array";
      prop["x-ui-component"] = "uploaders";
      prop.items = { type: "string" };
    } else {
      prop.items = { type: item.schema.type ?? src.items.type ?? "string" };
      if (src.items.enum || item.schema.enum) {
        prop.items.enum = src.items.enum ?? item.schema.enum;
      }
    }
  }

  return prop;
}

/** Find the queue input schema: prefer "*Input", fall back to "*Request". */
function findInputSchema(
  schemas: Record<string, RegistrySchemaObject>,
): RegistrySchemaObject | undefined {
  const key =
    Object.keys(schemas).find(
      (k) => k.endsWith("Input") && !k.startsWith("Queue"),
    ) ?? Object.keys(schemas).find((k) => k.endsWith("Request"));
  return key ? schemas[key] : undefined;
}

export function registryEntryToModel(entry: RegistryEntry): Model {
  const md = entry.metadata ?? {};
  const model: Model = {
    model_id: entry.endpoint_id,
    name: md.display_name ?? entry.endpoint_id,
    description: md.description,
    type: md.category,
    thumbnail: md.thumbnail_url,
  };

  const openapi = entry.openapi as RegistryOpenApi | undefined;
  const schemas = openapi?.components?.schemas;
  if (!schemas) return model;

  const input = findInputSchema(schemas);
  if (!input?.properties) return model;

  const properties: Record<string, SchemaProperty> = {};
  for (const [name, raw] of Object.entries(input.properties)) {
    const prop = convertProperty(raw, schemas);
    if (HIDDEN_FIELDS.has(name)) prop["x-hidden"] = true;
    properties[name] = prop;
  }

  const order = (input["x-fal-order-properties"] ?? []).filter(
    (n) => !HIDDEN_FIELDS.has(n),
  );

  model.api_schema = {
    // Shape consumed by DynamicForm/getFormFieldsFromModel at runtime
    api_schemas: [
      {
        type: "model_run",
        request_schema: {
          type: "object",
          properties,
          required: input.required ?? [],
          "x-order-properties": order.length > 0 ? order : undefined,
        },
      },
    ],
  } as Model["api_schema"];

  return model;
}
