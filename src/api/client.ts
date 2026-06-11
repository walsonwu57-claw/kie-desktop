import axios, { AxiosInstance, AxiosError } from "axios";
import type { Model } from "@/types/model";
import type { PredictionResult, HistoryResponse } from "@/types/prediction";
import { registryEntryToModel, type RegistryEntry } from "./registry-converter";
import modelRegistry from "@/data/kie-models.json";

// kie.ai service hosts
const API_BASE = "https://api.kie.ai"; // task + account APIs
const UPLOAD_BASE = "https://kieai.redpandaai.co"; // file upload service

/**
 * Local model catalog, bundled at build time (src/data/kie-models.json),
 * scraped from docs.kie.ai OpenAPI specs.
 * Add models with: node scripts/add-model.mjs <docs-page-slug>
 */
const LOCAL_MODELS: Model[] = (modelRegistry as RegistryEntry[]).map(
  registryEntryToModel,
);

// Custom error class with detailed information
export class APIError extends Error {
  code?: number;
  status?: number;
  details?: unknown;

  constructor(
    message: string,
    options?: { code?: number; status?: number; details?: unknown },
  ) {
    super(message);
    this.name = "APIError";
    this.code = options?.code;
    this.status = options?.status;
    this.details = options?.details;
  }
}

/** kie envelope: HTTP is usually 200; the real status lives in body.code. */
interface KieEnvelope<T> {
  code: number;
  msg?: string;
  data: T;
}

/** Throw if a kie envelope reports failure; return data otherwise. */
function unwrap<T>(body: KieEnvelope<T>, fallback: string): T {
  if (body.code !== 200) {
    throw new APIError(body.msg || fallback, {
      code: body.code,
      status: body.code,
      details: body,
    });
  }
  return body.data;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof APIError) return error.message;
  if (error instanceof AxiosError) {
    const response = error.response;
    const status = response?.status;

    if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
      return `Request timed out. The server may be experiencing high load.`;
    }
    if (error.code === "ERR_NETWORK") {
      return `Network error: Unable to connect to the server. Please check your internet connection.`;
    }
    if (response?.data) {
      const data = response.data as Record<string, unknown>;
      const prefix = status ? `[${status}] ` : "";
      if (typeof data.msg === "string") return `${prefix}${data.msg}`;
      if (typeof data.message === "string") return `${prefix}${data.message}`;
      return `${prefix}${JSON.stringify(data)}`;
    }
    if (status) return `HTTP ${status}`;
    if (error.message) return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function createAPIError(error: unknown, fallbackMessage: string): APIError {
  if (error instanceof APIError) return error;
  const message = extractErrorMessage(error) || fallbackMessage;
  const axiosError = error instanceof AxiosError ? error : null;
  return new APIError(message, {
    status: axiosError?.response?.status,
    details: axiosError?.response?.data,
  });
}

export interface RunOptions {
  timeout?: number;
  pollInterval?: number;
  enableSyncMode?: boolean;
  signal?: AbortSignal;
}

export interface HistoryFilters {
  model?: string;
  status?: "completed" | "failed" | "processing" | "created";
  created_after?: string;
  created_before?: string;
}

export interface PricingResult {
  price: number;
  discountedPrice: number;
  discountRate?: number;
}

// ─── kie task protocol types ─────────────────────────────────────────────────

interface KieTaskRecord {
  taskId: string;
  model: string;
  state: "waiting" | "queuing" | "generating" | "success" | "fail";
  param?: string;
  resultJson?: string;
  failCode?: string;
  failMsg?: string;
  progress?: number;
  createTime?: number;
  completeTime?: number;
  creditsConsumed?: number;
}

/** Map kie task state to the internal prediction status. */
function mapState(state: KieTaskRecord["state"]): PredictionResult["status"] {
  switch (state) {
    case "waiting":
    case "queuing":
      return "created";
    case "generating":
      return "processing";
    case "success":
      return "completed";
    case "fail":
      return "failed";
  }
}

/** Parse resultJson and collect output URLs (resultUrls + any nested url fields). */
export function extractOutputs(
  resultJson: string | undefined,
): (string | Record<string, unknown>)[] {
  if (!resultJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return /^https?:\/\//.test(resultJson) ? [resultJson] : [];
  }

  const outputs: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (!node || seen.has(node)) return;
    if (typeof node === "string") {
      if (/^https?:\/\//.test(node) || node.startsWith("data:")) {
        outputs.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      seen.add(node);
      node.forEach(walk);
      return;
    }
    if (typeof node === "object") {
      seen.add(node);
      const obj = node as Record<string, unknown>;
      if (typeof obj.url === "string") {
        outputs.push(obj.url);
        return;
      }
      // Known containers first for stable ordering
      for (const key of [
        "resultUrls",
        "result_urls",
        "urls",
        "images",
        "videos",
        "audio",
        "outputs",
      ]) {
        if (key in obj) walk(obj[key]);
      }
      for (const value of Object.values(obj)) {
        if (typeof value === "string") walk(value);
      }
    }
  };
  walk(parsed);
  return [...new Set(outputs)];
}

/**
 * Sliding-window rate limiter for task creation.
 * kie allows 20 new requests / 10s per account — batch mode can exceed this.
 */
class RateLimiter {
  private timestamps: number[] = [];
  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 50;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, waitMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new DOMException("Cancelled", "AbortError"));
          },
          { once: true },
        );
      });
    }
  }
}

class KieClient {
  private api: AxiosInstance; // api.kie.ai
  private uploader: AxiosInstance; // kieai.redpandaai.co
  private apiKey: string = "";
  private createLimiter = new RateLimiter(18, 10_000); // safety margin under 20/10s

  constructor() {
    const headers = { "Content-Type": "application/json" };
    this.api = axios.create({ baseURL: API_BASE, timeout: 60000, headers });
    this.uploader = axios.create({
      baseURL: UPLOAD_BASE,
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    for (const client of [this.api, this.uploader]) {
      client.interceptors.request.use((config) => {
        const key = this.getApiKey();
        if (key) {
          config.headers.Authorization = `Bearer ${key}`;
        }
        return config;
      });
    }
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  /** Validate the key via the credits endpoint (body code 401 → invalid). */
  async validateKey(): Promise<boolean> {
    try {
      const response = await this.api.get<KieEnvelope<number>>(
        "/api/v1/chat/credit",
      );
      if (response.data.code === 200) return true;
      if (response.data.code === 401) return false;
      throw new APIError(response.data.msg || "Validation failed", {
        code: response.data.code,
      });
    } catch (error) {
      const status =
        error instanceof AxiosError ? error.response?.status : undefined;
      if (status === 401 || status === 403) return false;
      throw createAPIError(error, "Failed to validate API key");
    }
  }

  /** Account credits (unit: credits, not USD). */
  async getBalance(): Promise<number> {
    try {
      const response = await this.api.get<KieEnvelope<number>>(
        "/api/v1/chat/credit",
      );
      return unwrap(response.data, "Failed to fetch credits");
    } catch (error) {
      throw createAPIError(error, "Failed to fetch credits");
    }
  }

  /** Catalog is bundled locally — no network, registry order preserved. */
  async listModels(): Promise<Model[]> {
    return LOCAL_MODELS;
  }

  /** Submit a task. Returns a PredictionResult in "created" state. */
  async runPrediction(
    model: string,
    input: Record<string, unknown>,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<PredictionResult> {
    try {
      await this.createLimiter.acquire(options?.signal);
      const response = await this.api.post<KieEnvelope<{ taskId: string }>>(
        "/api/v1/jobs/createTask",
        { model, input },
        {
          timeout: options?.timeout,
          ...(options?.signal && { signal: options.signal }),
        },
      );
      const data = unwrap(response.data, "Failed to create task");
      if (!data?.taskId) {
        throw new APIError("No taskId in createTask response", {
          details: response.data,
        });
      }
      return { id: data.taskId, model, status: "created" };
    } catch (error) {
      throw createAPIError(error, "Failed to run prediction");
    }
  }

  /** Poll a task. kie task ids are global — no model needed to reconstruct. */
  async getResult(
    taskId: string,
    options?: { signal?: AbortSignal; model?: string },
  ): Promise<PredictionResult> {
    let record: KieTaskRecord;
    try {
      const response = await this.api.get<KieEnvelope<KieTaskRecord>>(
        `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
        { ...(options?.signal && { signal: options.signal }) },
      );
      record = unwrap(response.data, "Failed to get task record");
    } catch (error) {
      // Re-throw AxiosError directly so the polling loop in run() can detect
      // connection errors and retry instead of aborting the entire prediction.
      if (error instanceof AxiosError) throw error;
      throw createAPIError(error, "Failed to get result");
    }

    const status = mapState(record.state);
    const result: PredictionResult = {
      id: taskId,
      model: record.model ?? options?.model ?? "",
      status,
    };
    if (status === "completed") {
      result.outputs = extractOutputs(record.resultJson);
    }
    if (status === "failed") {
      result.error = record.failMsg || record.failCode || "Task failed";
    }
    return result;
  }

  async getPredictionDetails(
    predictionId: string,
    model?: string,
  ): Promise<PredictionResult & { input?: Record<string, unknown> }> {
    return this.getResult(predictionId, { model });
  }

  /** kie has no cancel API — tasks run to completion server-side. */
  async cancelPrediction(_taskId: string, _model?: string): Promise<void> {
    // no-op
  }

  // Check if error is a connection/network error that should be retried
  private isConnectionError(error: unknown): boolean {
    if (error instanceof AxiosError) {
      if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
        return true;
      }
      if (
        error.code === "ERR_NETWORK" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ENOTFOUND"
      ) {
        return true;
      }
    }
    return false;
  }

  async run(
    model: string,
    input: Record<string, unknown>,
    options: RunOptions = {},
  ): Promise<PredictionResult> {
    const { timeout = 36000000, pollInterval = 1500, signal } = options;

    const throwIfAborted = (): void => {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    };

    throwIfAborted();
    const prediction = await this.runPrediction(model, input, { signal });
    const taskId = prediction.id;

    // Poll for result with unlimited retry on connection errors
    const startTime = Date.now();
    let consecutiveErrors = 0;
    while (true) {
      throwIfAborted();
      if (Date.now() - startTime > timeout) {
        throw new Error("Prediction timed out");
      }

      try {
        const result = await this.getResult(taskId, { signal, model });
        consecutiveErrors = 0;

        if (result.status === "completed") {
          return result;
        }
        if (result.status === "failed") {
          throw new APIError(result.error || "Prediction failed", {
            details: result,
          });
        }
      } catch (error) {
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        if (this.isConnectionError(error)) {
          consecutiveErrors++;
          const backoff = Math.min(
            1000 * Math.pow(2, consecutiveErrors - 1),
            10000,
          );
          console.warn(
            `Connection error during polling (attempt ${consecutiveErrors}), retrying in ${backoff}ms...`,
            error,
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw error;
      }

      throwIfAborted();
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, pollInterval);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new DOMException("Cancelled", "AbortError"));
            },
            { once: true },
          );
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }
  }

  /** kie exposes no task-list API — history is local-only. */
  async getHistory(
    page: number = 1,
    _pageSize: number = 20,
    _filters?: HistoryFilters,
  ): Promise<HistoryResponse["data"]> {
    return { page, total: 0, items: [] };
  }

  async deletePrediction(_predictionId: string): Promise<void> {
    throw new APIError("Deleting server tasks is not supported on kie.ai");
  }

  async deletePredictions(_predictionIds: string[]): Promise<void> {
    throw new APIError("Deleting server tasks is not supported on kie.ai");
  }

  /**
   * Upload via kie's file service (multipart stream upload).
   * Note: kie deletes uploaded files after ~3 days — auto-save assets locally.
   */
  async uploadFile(
    file: File,
    signal?: AbortSignal,
    onUploadProgress?: (progress: number) => void,
  ): Promise<string> {
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("uploadPath", "images/user");
      formData.append("fileName", file.name);

      // Dynamic timeout: min 2 minutes + 1s/MB, max 10 minutes
      const fileSizeMb = file.size / (1024 * 1024);
      const timeout = Math.min(
        600000,
        Math.max(120000, Math.ceil(fileSizeMb) * 1000 + 120000),
      );

      const response = await this.uploader.post<
        KieEnvelope<{ downloadUrl?: string; fileUrl?: string }>
      >("/api/file-stream-upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout,
        ...(signal && { signal }),
        onUploadProgress: onUploadProgress
          ? (e) => {
              if (e.total) {
                onUploadProgress(Math.round((e.loaded / e.total) * 100));
              }
            }
          : undefined,
      });

      const data = unwrap(response.data, "Failed to upload file");
      const url = data?.downloadUrl ?? data?.fileUrl;
      if (!url) {
        throw new APIError("No download URL in upload response", {
          details: response.data,
        });
      }
      return url;
    } catch (error) {
      if (
        axios.isCancel(error) ||
        (error instanceof Error && error.name === "CanceledError")
      ) {
        throw new APIError("Upload cancelled", { code: 0 });
      }
      throw createAPIError(error, "Failed to upload file");
    }
  }

  async optimizePrompt(_input: Record<string, unknown>): Promise<string> {
    throw new APIError("Prompt optimization is not available on kie.ai");
  }

  async calculatePricing(
    _modelId: string,
    _inputs: Record<string, unknown>,
  ): Promise<PricingResult> {
    throw new APIError("Pricing API is not available on kie.ai");
  }
}

export const apiClient = new KieClient();

export default apiClient;
