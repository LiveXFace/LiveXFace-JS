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
  CompareInput,
  LivenessInput,
  LivenessResult,
  ActiveLivenessResult,
  BatchRegisterItem,
  BatchResponse,
  BatchDeleteResponse,
  AttributesInput,
  AttributesResult,
  BatchJob,
} from "./types";

const DEFAULT_BASE_URL = "http://localhost:8080/api/v1";
const DEFAULT_TIMEOUT = 30_000;

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

  public readonly faces: FacesResource;

  constructor(config: LiveXFaceConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;

    this.faces = new FacesResource(this);
  }

  /** @internal */
  async _request<T>(
    method: string,
    endpoint: string,
    options: { body?: BodyInit; json?: unknown; formData?: FormData } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
    };

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
      );
    }

    if (!parsed.success || !response.ok) {
      throw new LiveXFaceApiError(
        parsed.error?.code ?? "UNKNOWN_ERROR",
        parsed.error?.message ?? "An unknown error occurred",
        response.status,
        parsed.requestId,
        parsed.error?.details,
      );
    }

    return parsed.data as T;
  }
}

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
   * a blink, a head turn and passive anti-spoofing. When the check passes the
   * result carries a single-use `livenessToken`, valid for 5 minutes and bound
   * to this collection, that {@link register} and the batch methods accept
   * for collections that require liveness at enrolment.
   */
  async activeLiveness(
    collectionId: string,
    frames: Array<Blob | Buffer | ArrayBuffer>,
  ): Promise<ActiveLivenessResult> {
    const form = new FormData();
    for (let i = 0; i < frames.length; i++) {
      form.append(`frame_${i}`, await toBlob(frames[i]), `frame_${i}.jpg`);
    }
    return this.client._request<ActiveLivenessResult>(
      "POST",
      `/collections/${collectionId}/active-liveness`,
      { formData: form },
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
      { formData: form },
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
      { formData: form },
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
