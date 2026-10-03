export class LiveXFaceApiError extends Error {
    public readonly code: string
    public readonly statusCode: number
    public readonly requestId?: string
    /** Machine-readable context when the API sends it, e.g. `faceCount` and `faces` for `MULTIPLE_FACES`. */
    public readonly details?: Record<string, unknown>
    /** Seconds from the response's `Retry-After` header (sent with 429 and 503), when it held a whole number. */
    public readonly retryAfter?: number

    constructor(
        code: string,
        message: string,
        statusCode: number,
        requestId?: string,
        details?: Record<string, unknown>,
        retryAfter?: number,
    ) {
        super(message)
        this.name = 'LiveXFaceApiError'
        this.code = code
        this.statusCode = statusCode
        this.requestId = requestId
        this.details = details
        this.retryAfter = retryAfter
        Object.setPrototypeOf(this, LiveXFaceApiError.prototype)
    }
}

export class LiveXFaceNetworkError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message)
        this.name = 'LiveXFaceNetworkError'
        Object.setPrototypeOf(this, LiveXFaceNetworkError.prototype)
    }
}
