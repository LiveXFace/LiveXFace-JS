// ─── API Response ─────────────────────────────────────────────────────────────

export interface APIResponse<T = unknown> {
    success: boolean
    data?: T
    error?: APIError
    message?: string
    request_id?: string
    timestamp: string
}

export interface APIError {
    code: string
    message: string
}

// ─── Collections ──────────────────────────────────────────────────────────────

export interface FaceCollection {
    id: string
    organization_id: string
    name: string
    description?: string
    face_count: number
    retention_days?: number | null
    created_at: string
    updated_at: string
}

export interface CreateCollectionInput {
    name: string
    description?: string
    retention_days?: number
}

// ─── Faces ────────────────────────────────────────────────────────────────────

export interface Face {
    id: string
    collection_id: string
    external_id: string
    metadata: Record<string, unknown>
    image_url?: string
    created_at: string
}

export interface RegisterFaceInput {
    external_id: string
    /** Image as a Blob (browser) or Buffer/ArrayBuffer (Node.js) */
    image: Blob | Buffer | ArrayBuffer
    metadata?: Record<string, unknown>
    filename?: string
}

export interface ListFacesInput {
    external_id?: string
    limit?: number
    offset?: number
}

export interface ListFacesResponse {
    items: Face[]
    total: number
}

// ─── Recognition ──────────────────────────────────────────────────────────────

export interface VerifyInput {
    image: Blob | Buffer | ArrayBuffer
    face_id?: string
    threshold?: number
    filename?: string
}

export interface VerifyResult {
    match: boolean
    confidence: number
    /** The threshold actually applied to this request */
    thresholdUsed: number
    faceId?: string
}

export interface IdentifyMatch {
    faceId: string
    externalId: string
    confidence: number
    metadata?: Record<string, unknown>
}

export interface IdentifyInput {
    image: Blob | Buffer | ArrayBuffer
    top_k?: number
    threshold?: number
    /** If true, only return results for live (non-spoofed) faces */
    live?: boolean
    filename?: string
}

export interface IdentifyResult {
    matches: IdentifyMatch[]
    queryTimeMs: number
}

export interface CompareInput {
    image1: Blob | Buffer | ArrayBuffer
    image2: Blob | Buffer | ArrayBuffer
    threshold?: number
    filename1?: string
    filename2?: string
}

export interface CompareResult {
    match: boolean
    confidence: number
    threshold: number
}

export interface LivenessInput {
    image: Blob | Buffer | ArrayBuffer
    filename?: string
}

export interface LivenessResult {
    isLive: boolean
    livenessScore: number
    faceDetected: boolean
    faceCount: number
}

// ─── Batch ────────────────────────────────────────────────────────────────────

export interface BatchRegisterItem {
    external_id: string
    image: Blob | Buffer | ArrayBuffer
    metadata?: Record<string, unknown>
    filename?: string
}

export interface BatchFaceResult {
    external_id: string
    face?: Face
    error?: string
}

export interface BatchResponse {
    succeeded: number
    failed: number
    results: BatchFaceResult[]
}

export interface BatchDeleteResult {
    face_id: string
    error?: string
}

export interface BatchDeleteResponse {
    succeeded: number
    failed: number
    results: BatchDeleteResult[]
}

// ─── Face Attributes ──────────────────────────────────────────────────────────

export interface FaceBBox {
    x: number
    y: number
    width: number
    height: number
}

export interface ImageSize {
    width: number
    height: number
}

export interface HeadPose {
    yaw: number
    pitch: number
    roll: number
    frontal_score: number
}

export interface EmotionResult {
    label: string
    confidence: number
    scores?: Record<string, number>
}

export interface DetectionResult {
    detected: boolean
    confidence: number
}

export interface FaceAttributes {
    age: number
    gender: string
    det_score: number
    bbox: FaceBBox
    landmarks_5pt?: number[][]
    landmarks_106?: number[][]
    head_pose?: HeadPose
    emotion?: EmotionResult
    glasses?: DetectionResult
    mask?: DetectionResult
}

export interface AttributesInput {
    image: Blob | Buffer | ArrayBuffer
    filename?: string
}

export interface AttributesResult {
    face_detected: boolean
    face_count: number
    /** Attributes of the primary (highest-confidence) face */
    primary?: FaceAttributes
    faces: FaceAttributes[]
    image_size?: ImageSize
}

// ─── Async Batch Jobs ─────────────────────────────────────────────────────────

export type BatchJobStatus = 'queued' | 'processing' | 'done' | 'failed'

export interface BatchJobResult {
    index: number
    external_id: string
    face_id?: string
    error?: string
}

export interface BatchJob {
    id: string
    collection_id: string
    status: BatchJobStatus
    total: number
    processed: number
    succeeded: number
    failed: number
    /** Per-image results; present once the job has started producing them */
    results?: BatchJobResult[]
    created_at: string
    updated_at: string
}

// ─── Client Config ─────────────────────────────────────────────────────────────

export interface FRClientConfig {
    /** Your API key (fr_live_xxx or fr_test_xxx) */
    apiKey: string
    /** Base URL of the FR-APIaaS instance. Defaults to https://api.fr-apiaas.io/api/v1 */
    baseUrl?: string
    /** Request timeout in milliseconds. Defaults to 30000 */
    timeout?: number
}
