import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { LiveXFaceApiError, LiveXFaceNetworkError } from "./error";
import type {
  APIResponse,
  LiveXFaceConfig,
  Face,
  RegisterFaceInput,
  ListFacesInput,
  ListFacesResponse,
  VerifyInput,
  VerifyResult,
  IdentifyInput,
  IdentifyResult,
  CrossCollectionSearchInput,
  CrossCollectionSearchResult,
  CompareInput,
  LivenessInput,
  LivenessResult,
  ActiveLivenessResult,
  LivenessSession,
  LivenessSessionResult,
  CompleteLivenessSessionOptions,
  BatchRegisterItem,
  BatchResponse,
  BatchDeleteResponse,
  AttributesInput,
  AttributesResult,
  BatchJob,
  IdempotencyOptions,
} from "./types";

const DEFAULT_BASE_URL = "http://localhost:8080/api/v1";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRY_DELAY = 60_000;
// Repeating these is harmless, so a network error or 5xx may be retried.
const SAFE_METHODS = ["GET", "PATCH", "DELETE"];

type ImageSource = Blob | Buffer | ArrayBuffer | string; // string = file path

/**
 * Convert an image source (Blob, Buffer, ArrayBuffer, or file path) to a Blob
 * for use in FormData.
 */
async function toBlob(src: ImageSource, filename = "image.jpg"): Promise<Blob> {
  if (src instanceof Blob) return src;
  if (typeof src === "string") {
    const buffer = fs.readFileSync(src);
    const ext = path.extname(src).slice(1) || "jpeg";
    return new Blob([buffer], { type: `image/${ext}` });
  }
  if (Buffer.isBuffer(src)) {
    return new Blob([new Uint8Array(src)], { type: "image/jpeg" });
  }
  return new Blob([src], { type: "image/jpeg" });
}

/**
 * Generate a random idempotency key (a UUID v4) for the enrolment and batch
 * methods. Uses Web Crypto where present (browsers, Node 19+), else Node's
 * crypto module.
 */
export function generateIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? crypto.randomUUID();
}

/** Whole seconds from a `Retry-After` header; an HTTP-date is ignored. */
function parseRetryAfter(value: string | null): number | undefined {
  const v = value?.trim();
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
}

/**
 * LiveXFace — main client for the LiveXFace recognition API.
 *
 * All face operations (register, verify, identify, liveness, compare) use
 * API key authentication scoped to a specific collection. Collections
 * themselves are created and managed in the dashboard; the API has no
 * endpoints for that, so neither does this client.
 *
 * @example
 * ```ts
 * import { LiveXFace } from 'livexface'
 *
 * const client = new LiveXFace({ apiKey: 'lxf_live_xxxx' })
 *
 * const result = await client.faces.identify('col_id', {
 *   image: fs.readFileSync('./face.jpg'),
 *   topK: 3,
 * })
 * ```
 */
export class LiveXFace {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly maxRetryDelay: number;

  /** @internal Replaced in tests so retries do not really wait. */
  _sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  public readonly faces: FacesResource;

  constructor(config: LiveXFaceConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? 0;
    this.maxRetryDelay = config.maxRetryDelay ?? DEFAULT_MAX_RETRY_DELAY;

    this.faces = new FacesResource(this);
  }

  /**
   * @internal The caller's key, or with retries on a fresh one, so every
   * attempt of one enrolment call carries the same key.
   */
  _idempotencyKey(key?: string): string | undefined {
    return key ?? (this.maxRetries > 0 ? generateIdempotencyKey() : undefined);
  }

  /** @internal */
  async _request<T>(
    method: string,
    endpoint: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const safe =
      options.idempotencyKey !== undefined || SAFE_METHODS.includes(method);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._attempt<T>(method, endpoint, options);
      } catch (err) {
        const delay =
          attempt < this.maxRetries
            ? this._retryDelay(err, safe, attempt, options.retryBusy ?? true)
            : undefined;
        if (delay === undefined) throw err;
        await this._sleep(delay);
      }
    }
  }

  /** Milliseconds to wait before retrying after `err`, or undefined to give up. */
  private _retryDelay(
    err: unknown,
    safe: boolean,
    attempt: number,
    retryBusy: boolean,
  ): number | undefined {
    let retryAfter: number | undefined;
    if (err instanceof LiveXFaceApiError) {
      const status = err.statusCode;
      if (status === 429 || (status === 503 && retryBusy)) retryAfter = err.retryAfter;
      else if (status < 500 || !safe) return undefined;
    } else if (!(err instanceof LiveXFaceNetworkError) || !safe) {
      return undefined;
    }
    // Full jitter: anywhere between 0 and 0.5 s * 2^attempt.
    const ms =
      retryAfter !== undefined
        ? retryAfter * 1000
        : Math.random() * 500 * 2 ** attempt;
    return Math.min(ms, this.maxRetryDelay);
  }

  /**
   * One HTTP round trip. The body is rebuilt from `options` each time; a
   * FormData or JSON string can be sent again, so retries replay it.
   */
  private async _attempt<T>(
    method: string,
    endpoint: string,
    options: RequestOptions,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
    };
    if (options.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.formData) {
      body = options.formData;
    } else {
      body = options.body;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LiveXFaceNetworkError(
          `Request timed out after ${this.timeout}ms`,
          err,
        );
      }
      throw new LiveXFaceNetworkError(`Network request failed: ${String(err)}`, err);
    } finally {
      clearTimeout(timer);
    }

    // A delete answers 204 with no body. Parsing it used to throw
    // PARSE_ERROR, so every successful delete looked like a failure.
    if (response.status === 204) {
      return undefined as T;
    }

    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    let parsed: APIResponse<T>;
    try {
      parsed = (await response.json()) as APIResponse<T>;
    } catch {
      // An unknown route answers with a plain-text 404, not the JSON
      // envelope; report the HTTP status rather than a parse failure.
      throw new LiveXFaceApiError(
        response.ok ? "PARSE_ERROR" : `HTTP_${response.status}`,
        response.ok
          ? "Failed to parse response body"
          : `Request failed with HTTP ${response.status}`,
        response.status,
        undefined,
        undefined,
        retryAfter,
      );
    }

    if (!parsed.success || !response.ok) {
      throw new LiveXFaceApiError(
        parsed.error?.code ?? "UNKNOWN_ERROR",
        parsed.error?.message ?? "An unknown error occurred",
        response.status,
        parsed.requestId,
        parsed.error?.details,
        retryAfter,
      );
    }

    return parsed.data as T;
  }
}

type RequestOptions = {
  body?: BodyInit;
  json?: unknown;
  formData?: FormData;
  idempotencyKey?: string;
  /** False when a 503 means the request was consumed, so a retry cannot succeed. */
  retryBusy?: boolean;
};

/**
 * Serialize a batch item into its `entries` JSON object. `livenessToken` is
 * omitted when unset rather than sent as null.
 */
function toBatchEntry(item: BatchRegisterItem): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    externalId: item.externalId,
    metadata: item.metadata ?? {},
  };
  if (item.livenessToken) entry.livenessToken = item.livenessToken;
  return entry;
}

/** Frames as multipart files `frame_0`, `frame_1`, ... in order. */
async function framesForm(
  frames: Array<Blob | Buffer | ArrayBuffer>,
): Promise<FormData> {
  const form = new FormData();
  for (let i = 0; i < frames.length; i++) {
    form.append(`frame_${i}`, await toBlob(frames[i]), `frame_${i}.jpg`);
  }
  return form;
}

// ─── Faces Resource ───────────────────────────────────────────────────────────

export class FacesResource {
  constructor(private readonly client: LiveXFace) {}

  /** Register a face in a collection. */
  async register(
    collectionId: string,
    input: RegisterFaceInput,
  ): Promise<Face> {
    const form = new FormData();
    form.append("external_id", input.externalId);
    form.append("image", await toBlob(input.image), "image.jpg");
    if (input.metadata) {
      form.append("metadata", JSON.stringify(input.metadata));
    }
    if (input.livenessToken) {
      form.append("liveness_token", input.livenessToken);
    }
    return this.client._request<Face>(
      "POST",
      `/collections/${collectionId}/faces`,
      {
        formData: form,
        idempotencyKey: this.client._idempotencyKey(input.idempotencyKey),
      },
    );
  }

  /** List faces in a collection. */
  async list(
    collectionId: string,
    input: ListFacesInput = {},
  ): Promise<ListFacesResponse> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.offset !== undefined) params.set("offset", String(input.offset));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.client._request<ListFacesResponse>(
      "GET",
      `/collections/${collectionId}/faces${qs}`,
    );
  }

  /** Get a face by ID. */
  async get(collectionId: string, faceId: string): Promise<Face> {
    return this.client._request<Face>(
      "GET",
      `/collections/${collectionId}/faces/${faceId}`,
    );
  }

  /**
   * Get a face by external ID. Returns the first match. Filtering by
   * external ID makes the API answer with a bare array rather than the
   * paginated `{ faces, total }` object.
   */
  async getByExternalId(
    collectionId: string,
    externalId: string,
  ): Promise<Face> {
    const result = await this.client._request<Face[]>(
      "GET",
      `/collections/${collectionId}/faces?external_id=${encodeURIComponent(externalId)}`,
    );
    const items = Array.isArray(result) ? result : []
    if (items.length === 0) throw new LiveXFaceApiError('FACE_NOT_FOUND', `No face found with external_id "${externalId}"`, 404)
    return items[0]
  }

  /** Delete a face from a collection. */
  async delete(collectionId: string, faceId: string): Promise<void> {
    return this.client._request<void>(
      "DELETE",
      `/collections/${collectionId}/faces/${faceId}`,
    );
  }

  /**
   * 1:1 Verify — compare a query image against a stored face.
   * @param collectionId  Collection that contains the reference face
   * @param input.faceId  ID of the stored face to compare against
   */
  async verify(
    collectionId: string,
    input: VerifyInput,
  ): Promise<VerifyResult> {
    const form = new FormData();
    form.append("image", await toBlob(input.image), "image.jpg");
    form.append("face_id", input.faceId);
    if (input.threshold !== undefined)
      form.append("threshold", String(input.threshold));
    return this.client._request<VerifyResult>(
      "POST",
      `/collections/${collectionId}/verify`,
      {
        formData: form,
      },
    );
  }

  /**
   * 1:N Identify — search a collection for the best matching faces.
   */
  async identify(
    collectionId: string,
    input: IdentifyInput,
  ): Promise<IdentifyResult> {
    const form = new FormData();
    form.append("image", await toBlob(input.image), "image.jpg");
    if (input.topK !== undefined) form.append("top_k", String(input.topK));
    if (input.threshold !== undefined)
      form.append("threshold", String(input.threshold));
    return this.client._request<IdentifyResult>(
      "POST",
      `/collections/${collectionId}/identify`,
      { formData: form },
    );
  }

  /** Search for matching faces across multiple or all collections. */
  async search(input: CrossCollectionSearchInput): Promise<CrossCollectionSearchResult> {
    const form = new FormData();
    form.append("image", await toBlob(input.image), input.filename ?? "image.jpg");
    if (input.collectionIds?.length) form.append("collection_ids", input.collectionIds.join(","));
    if (input.topK !== undefined) form.append("top_k", String(input.topK));
    if (input.threshold !== undefined) form.append("threshold", String(input.threshold));
    return this.client._request<CrossCollectionSearchResult>("POST", "/search", { formData: form });
  }

  /**
   * Liveness detection — check whether the face in the image is live (anti-spoofing).
   */
  async liveness(
    collectionId: string,
    input: LivenessInput,
  ): Promise<LivenessResult> {
    const form = new FormData();
    form.append("image", await toBlob(input.image), "image.jpg");
    return this.client._request<LivenessResult>(
      "POST",
      `/collections/${collectionId}/liveness`,
      { formData: form },
    );
  }

  /**
   * Active liveness — analyse a short burst of frames (5 to 50, JPEG/PNG) for
   * a blink, a head turn and passive anti-spoofing. A verdict only: it issues
   * no liveness token. To enrol into a collection that requires liveness, use
   * {@link createLivenessSession} and {@link completeLivenessSession}.
   */
  async activeLiveness(
    collectionId: string,
    frames: Array<Blob | Buffer | ArrayBuffer>,
  ): Promise<ActiveLivenessResult> {
    return this.client._request<ActiveLivenessResult>(
      "POST",
      `/collections/${collectionId}/active-liveness`,
      { formData: await framesForm(frames) },
    );
  }

  /**
   * Start a liveness session. Show its `challenges` to the person in order,
   * capture frames while they perform them, and pass the frames to
   * {@link completeLivenessSession} before `expiresAt`.
   */
  async createLivenessSession(collectionId: string): Promise<LivenessSession> {
    return this.client._request<LivenessSession>(
      "POST",
      `/collections/${collectionId}/liveness-sessions`,
    );
  }

  /**
   * Submit the frames (5 to 50, JPEG/PNG) for a liveness session. A pass
   * carries a single-use `livenessToken`, valid for 5 minutes and bound to
   * this collection, for {@link register} and the batch methods.
   *
   * The session is used up by any submission except one with fewer than 5
   * frames, so it carries no idempotency key and is retried only on 429
   * (rejected before the session is touched), never on a network error or
   * 5xx. A 503 `SERVICE_BUSY` arrives after the session was used up, so it is
   * thrown at once: after it or `LIVENESS_SESSION_INVALID` (422), create a new
   * session.
   */
  async completeLivenessSession(
    collectionId: string,
    sessionId: string,
    frames: Array<Blob | Buffer | ArrayBuffer>,
    options: CompleteLivenessSessionOptions = {},
  ): Promise<LivenessSessionResult> {
    const form = await framesForm(frames);
    form.append("mirrored", String(options.mirrored ?? false));
    return this.client._request<LivenessSessionResult>(
      "POST",
      `/collections/${collectionId}/liveness-sessions/${sessionId}`,
      { formData: form, retryBusy: false },
    );
  }

  /**
   * Face comparison — compare two images without enrolling into a collection.
   */
  async compare(input: CompareInput): Promise<VerifyResult> {
    const form = new FormData();
    form.append("image1", await toBlob(input.image1), "image1.jpg");
    form.append("image2", await toBlob(input.image2), "image2.jpg");
    if (input.threshold !== undefined)
      form.append("threshold", String(input.threshold));
    return this.client._request<VerifyResult>("POST", "/compare", {
      formData: form,
    });
  }

  /**
   * Batch register up to 20 faces in a single request.
   */
  async batchRegister(
    collectionId: string,
    items: BatchRegisterItem[],
    options: IdempotencyOptions = {},
  ): Promise<BatchResponse> {
    const form = new FormData();
    const entries = items.map(toBatchEntry);
    form.append("entries", JSON.stringify(entries));
    for (let i = 0; i < items.length; i++) {
      form.append(
        `images[${i}]`,
        await toBlob(items[i].image),
        `${items[i].externalId}.jpg`,
      );
    }
    return this.client._request<BatchResponse>(
      "POST",
      `/collections/${collectionId}/faces/batch`,
      {
        formData: form,
        idempotencyKey: this.client._idempotencyKey(options.idempotencyKey),
      },
    );
  }

  /**
   * Batch delete up to 100 faces by their IDs.
   */
  async batchDelete(
    collectionId: string,
    faceIds: string[],
  ): Promise<BatchDeleteResponse> {
    return this.client._request<BatchDeleteResponse>(
      "DELETE",
      `/collections/${collectionId}/faces/batch`,
      { json: { faceIds } },
    );
  }

  /**
   * Detect face attributes (age, gender, emotion, glasses, mask, head pose,
   * landmarks) for all faces in an image. No face is enrolled.
   */
  async attributes(
    collectionId: string,
    input: AttributesInput,
  ): Promise<AttributesResult> {
    const form = new FormData();
    form.append("image", await toBlob(input.image), input.filename ?? "image.jpg");
    return this.client._request<AttributesResult>(
      "POST",
      `/collections/${collectionId}/attributes`,
      { formData: form },
    );
  }

  /**
   * Submit up to 100 faces for asynchronous registration. Returns a job
   * immediately (HTTP 202); poll {@link getBatchJob} until its status is
   * `done` or `failed`.
   */
  async batchRegisterAsync(
    collectionId: string,
    items: BatchRegisterItem[],
    options: IdempotencyOptions = {},
  ): Promise<BatchJob> {
    const form = new FormData();
    const entries = items.map(toBatchEntry);
    form.append("entries", JSON.stringify(entries));
    for (let i = 0; i < items.length; i++) {
      form.append(
        `images[${i}]`,
        await toBlob(items[i].image),
        `${items[i].externalId}.jpg`,
      );
    }
    return this.client._request<BatchJob>(
      "POST",
      `/collections/${collectionId}/faces/batch-async`,
      {
        formData: form,
        idempotencyKey: this.client._idempotencyKey(options.idempotencyKey),
      },
    );
  }

  /**
   * Fetch the status (and, when available, per-image results) of an async
   * batch registration job.
   */
  async getBatchJob(collectionId: string, jobId: string): Promise<BatchJob> {
    return this.client._request<BatchJob>(
      "GET",
      `/collections/${collectionId}/batch/${jobId}`,
    );
  }
}
