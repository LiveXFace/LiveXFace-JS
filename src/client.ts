import * as fs from "fs";
import * as path from "path";
import { FRApiError, FRNetworkError } from "./error";
import type {
  APIResponse,
  FRClientConfig,
  FaceCollection,
  CreateCollectionInput,
  Face,
  RegisterFaceInput,
  ListFacesInput,
  VerifyInput,
  VerifyResult,
  IdentifyInput,
  IdentifyResult,
  CompareInput,
  CompareResult,
  LivenessInput,
  LivenessResult,
  BatchRegisterItem,
  BatchResponse,
  BatchDeleteResponse,
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
 * FRClient — main client for the FR-APIaaS recognition API.
 *
 * All face operations (register, verify, identify, liveness, compare) use
 * API key authentication scoped to a specific collection.
 *
 * @example
 * ```ts
 * import { FRClient } from 'fr-apiaas-sdk'
 *
 * const client = new FRClient({ apiKey: 'fr_live_xxxx' })
 *
 * const result = await client.faces.identify('col_id', {
 *   image: fs.readFileSync('./face.jpg'),
 *   top_k: 3,
 * })
 * ```
 */
export class FRClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;

  public readonly collections: CollectionsResource;
  public readonly faces: FacesResource;

  constructor(config: FRClientConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;

    this.collections = new CollectionsResource(this);
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
        throw new FRNetworkError(
          `Request timed out after ${this.timeout}ms`,
          err,
        );
      }
      throw new FRNetworkError(`Network request failed: ${String(err)}`, err);
    } finally {
      clearTimeout(timer);
    }

    let parsed: APIResponse<T>;
    try {
      parsed = (await response.json()) as APIResponse<T>;
    } catch {
      throw new FRApiError(
        "PARSE_ERROR",
        "Failed to parse response body",
        response.status,
      );
    }

    if (!parsed.success || !response.ok) {
      throw new FRApiError(
        parsed.error?.code ?? "UNKNOWN_ERROR",
        parsed.error?.message ?? "An unknown error occurred",
        response.status,
        parsed.request_id,
      );
    }

    return parsed.data as T;
  }
}

// ─── Collections Resource ─────────────────────────────────────────────────────

export class CollectionsResource {
  constructor(private readonly client: FRClient) {}

  /** List all face collections accessible by this API key. */
  async list(): Promise<FaceCollection[]> {
    return this.client._request<FaceCollection[]>("GET", "/collections");
  }

  /** Get a single collection by ID. */
  async get(collectionId: string): Promise<FaceCollection> {
    return this.client._request<FaceCollection>(
      "GET",
      `/collections/${collectionId}`,
    );
  }

  /** Create a new face collection. */
  async create(input: CreateCollectionInput): Promise<FaceCollection> {
    return this.client._request<FaceCollection>("POST", "/collections", {
      json: input,
    });
  }

  /** Update collection name/description. */
  async update(
    collectionId: string,
    input: Partial<CreateCollectionInput>,
  ): Promise<FaceCollection> {
    return this.client._request<FaceCollection>(
      "PUT",
      `/collections/${collectionId}`,
      {
        json: input,
      },
    );
  }

  /** Delete a collection and all its faces. */
  async delete(collectionId: string): Promise<void> {
    return this.client._request<void>("DELETE", `/collections/${collectionId}`);
  }
}

// ─── Faces Resource ───────────────────────────────────────────────────────────

export class FacesResource {
  constructor(private readonly client: FRClient) {}

  /** Register a face in a collection. */
  async register(
    collectionId: string,
    input: RegisterFaceInput,
  ): Promise<Face> {
    const form = new FormData();
    form.append("external_id", input.external_id);
    form.append("image", await toBlob(input.image), "image.jpg");
    if (input.metadata) {
      form.append("metadata", JSON.stringify(input.metadata));
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
  ): Promise<{ faces: Face[]; total: number }> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.offset !== undefined) params.set("offset", String(input.offset));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.client._request<{ faces: Face[]; total: number }>(
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

  /** Get a face by external ID. Returns the first match. */
  async getByExternalId(
    collectionId: string,
    externalId: string,
  ): Promise<Face> {
    const result = await this.client._request<Face[]>(
      "GET",
      `/collections/${collectionId}/faces?external_id=${encodeURIComponent(externalId)}`,
    );
    const items = Array.isArray(result) ? result : []
    if (items.length === 0) throw new FRApiError('NOT_FOUND', `No face found with external_id "${externalId}"`, 404)
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
   * 1:1 Verify — compare a query image against a stored face or a second image.
   * @param collectionId  Collection that contains the reference face
   * @param input.face_id  ID of the stored face to compare against (mutually exclusive with ref_image)
   */
  async verify(
    collectionId: string,
    input: VerifyInput,
  ): Promise<VerifyResult> {
    const form = new FormData();
    form.append("image", await toBlob(input.image), "image.jpg");
    if (input.face_id) form.append("face_id", input.face_id);
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
    if (input.top_k !== undefined) form.append("top_k", String(input.top_k));
    if (input.threshold !== undefined)
      form.append("threshold", String(input.threshold));
    if (input.live !== undefined) form.append("live", String(input.live));
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
   * Face comparison — compare two images without enrolling into a collection.
   */
  async compare(input: CompareInput): Promise<CompareResult> {
    const form = new FormData();
    form.append("image1", await toBlob(input.image1), "image1.jpg");
    form.append("image2", await toBlob(input.image2), "image2.jpg");
    if (input.threshold !== undefined)
      form.append("threshold", String(input.threshold));
    return this.client._request<CompareResult>("POST", "/compare", {
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
    const entries = items.map((item) => ({
      external_id: item.external_id,
      metadata: item.metadata ?? {},
    }));
    form.append("entries", JSON.stringify(entries));
    for (let i = 0; i < items.length; i++) {
      form.append(
        `images[${i}]`,
        await toBlob(items[i].image),
        `${items[i].external_id}.jpg`,
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
      { json: { face_ids: faceIds } },
    );
  }
}
