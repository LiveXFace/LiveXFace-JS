// Every response type below mirrors what the API actually sends: JSON keys are
// camelCase. They used to be declared snake_case (external_id, created_at, ...)
// while the client returned the parsed JSON untouched, so those fields were
// always undefined at runtime.

// ─── API Response ─────────────────────────────────────────────────────────────

export interface APIResponse<T = unknown> {
    success: boolean
    data?: T
    error?: APIError
    message?: string
    requestId?: string
    timestamp?: string
}

export interface APIError {
    code: string
    message: string
    /** Present for codes that define it, e.g. MULTIPLE_FACES. */
    details?: Record<string, unknown>
}

// ─── Faces ────────────────────────────────────────────────────────────────────

export interface Face {
    id: string
    collectionId: string
    externalId: string
    metadata: Record<string, unknown>
    imageUrl?: string
    createdAt: string
}

export interface RegisterFaceInput {
    externalId: string
    /** Image as a Blob (browser) or Buffer/ArrayBuffer (Node.js) */
    image: Blob | Buffer | ArrayBuffer
    metadata?: Record<string, unknown>
    filename?: string
    /**
     * Single-use token from {@link LivenessSessionResult}. Required when the
     * collection requires liveness at enrolment.
     */
    livenessToken?: string
    /**
     * Sent as the `Idempotency-Key` header: repeating the call with the same
     * key replays the first result instead of enrolling again. See
     * {@link generateIdempotencyKey}.
     */
    idempotencyKey?: string
}

/** Options for the batch enrolment methods. */
export interface IdempotencyOptions {
    /** Sent as the `Idempotency-Key` header; see {@link RegisterFaceInput.idempotencyKey}. */
    idempotencyKey?: string
}

export interface ListFacesInput {
    limit?: number
    offset?: number
}

export interface ListFacesResponse {
    faces: Face[]
    total: number
    limit: number
    offset: number
}

// ─── Recognition ──────────────────────────────────────────────────────────────

export interface VerifyInput {
    image: Blob | Buffer | ArrayBuffer
    /** ID of the stored face to compare against */
    faceId: string
    threshold?: number
    filename?: string
}

/** Result of verify and of compare. `faceId` is set by verify only. */
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
    /** Number of matches to return (default 5, max 100) */
    topK?: number
    threshold?: number
    filename?: string
}

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

/** A face found in the query image, whether or not it matched anyone. */
export interface DetectedFace {
    bbox: FaceBBox
    detScore: number
}

export interface IdentifyResult {
    matches: IdentifyMatch[]
    queryTimeMs: number
    detectedFaces?: DetectedFace[]
    imageSize?: ImageSize
}

export interface CrossCollectionSearchInput {
    image: Blob | Buffer | ArrayBuffer
    collectionIds?: string[]
    topK?: number
    threshold?: number
    filename?: string
}

export interface CrossCollectionSearchMatch extends IdentifyMatch {
    collectionId: string
}

export interface SkippedCollection {
    id: string
    name: string
    reason: string
}

export interface CrossCollectionSearchResult {
    matches: CrossCollectionSearchMatch[]
    queryTimeMs: number
    collectionsSearched: number
    skippedCollections: SkippedCollection[]
    detectedFaces?: DetectedFace[]
    imageSize?: ImageSize
}

export interface CompareInput {
    image1: Blob | Buffer | ArrayBuffer
    image2: Blob | Buffer | ArrayBuffer
    threshold?: number
    filename1?: string
    filename2?: string
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

/**
 * One challenge of an active liveness check. `passed` is null when the
 * challenge could not be evaluated; `available` is false when the server has
 * no model for it. Extra keys carry challenge-specific metrics.
 */
export interface ActiveLivenessChallenge {
    passed: boolean | null
    available: boolean
    [metric: string]: unknown
}

export interface ActiveLivenessChallenges {
    blink: ActiveLivenessChallenge
    headTurn: ActiveLivenessChallenge
    passiveAntispoof: ActiveLivenessChallenge
}

export interface ActiveLivenessResult {
    isLive: boolean
    overallScore: number
    framesAnalyzed: number
    framesWithFace: number
    challenges: ActiveLivenessChallenges
}

// ─── Liveness Sessions ────────────────────────────────────────────────────────

/** A step of a liveness session. Left and right are the person's own. */
export type LivenessChallengeType = 'blink' | 'turn_left' | 'turn_right'

export interface LivenessChallenge {
    type: LivenessChallengeType
}

/** A liveness session: the steps to perform, in order, before `expiresAt`. */
export interface LivenessSession {
    sessionId: string
    challenges: LivenessChallenge[]
    /** RFC 3339; 60 seconds after creation by default */
    expiresAt: string
}

export interface LivenessStep {
    type: LivenessChallengeType
    passed: boolean
}

export interface CompleteLivenessSessionOptions {
    /** True when the frames are horizontally mirrored, as a selfie preview is. Defaults to false. */
    mirrored?: boolean
}

/** Result of completing a liveness session. */
export interface LivenessSessionResult extends ActiveLivenessResult {
    /** The session's challenges in order, each marked passed or not */
    steps: LivenessStep[]
    /** Single-use enrolment token, present only when the session passed */
    livenessToken?: string
    /** RFC 3339 expiry of `livenessToken` (5 minutes after issue) */
    livenessTokenExpiresAt?: string
}

// ─── Batch ────────────────────────────────────────────────────────────────────

export interface BatchRegisterItem {
    externalId: string
    image: Blob | Buffer | ArrayBuffer
    metadata?: Record<string, unknown>
    filename?: string
    /**
     * Single-use token from {@link LivenessSessionResult}. Required when the
     * collection requires liveness at enrolment.
     */
    livenessToken?: string
}

export interface BatchFaceResult {
    externalId: string
    face?: Face
    error?: string
}

export interface BatchResponse {
    succeeded: number
    failed: number
    results: BatchFaceResult[]
}

export interface BatchDeleteResult {
    faceId: string
    error?: string
}

export interface BatchDeleteResponse {
    succeeded: number
    failed: number
    results: BatchDeleteResult[]
}

// ─── Face Attributes ──────────────────────────────────────────────────────────

export interface HeadPose {
    yaw: number
    pitch: number
    roll: number
    frontalScore: number
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
    detScore: number
    bbox: FaceBBox
    landmarks5pt?: number[][]
    landmarks106?: number[][]
    headPose?: HeadPose
    emotion?: EmotionResult
    glasses?: DetectionResult
    mask?: DetectionResult
}

export interface AttributesInput {
    image: Blob | Buffer | ArrayBuffer
    filename?: string
}

export interface AttributesResult {
    faceDetected: boolean
    faceCount: number
    /** Attributes of the primary (highest-confidence) face */
    primary?: FaceAttributes
    faces: FaceAttributes[]
    imageSize?: ImageSize
}

// ─── Async Batch Jobs ─────────────────────────────────────────────────────────

export type BatchJobStatus = 'queued' | 'processing' | 'done' | 'failed'

export interface BatchJobResult {
    index: number
    externalId: string
    faceId?: string
    error?: string
}

export interface BatchJob {
    id: string
    collectionId: string
    status: BatchJobStatus
    total: number
    processed: number
    succeeded: number
    failed: number
    /** Per-image results; present once the job has started producing them */
    results?: BatchJobResult[]
    createdAt: string
    updatedAt: string
}

// ─── Client Config ─────────────────────────────────────────────────────────────

export interface LiveXFaceConfig {
    /** Your API key (lxf_live_xxx or lxf_test_xxx) */
    apiKey: string
    /** Base URL of the LiveXFace instance. Defaults to https://api.livexface.com/api/v1 */
    baseUrl?: string
    /** Request timeout in milliseconds. Defaults to 30000 */
    timeout?: number
    /**
     * Retries after the first attempt. Defaults to 0 (off). 429 and 503 are
     * retried after `Retry-After`; network errors and other 5xx only for
     * GET/PATCH/DELETE and requests with an idempotency key. Enrolment and
     * batch calls get a generated idempotency key when you give none.
     */
    maxRetries?: number
    /** Upper bound on one retry delay, in milliseconds. Defaults to 60000 */
    maxRetryDelay?: number
}
