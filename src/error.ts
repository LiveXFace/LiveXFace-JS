export class LiveXFaceApiError extends Error {
    public readonly code: string
    public readonly statusCode: number
    public readonly requestId?: string

    constructor(code: string, message: string, statusCode: number, requestId?: string) {
        super(message)
        this.name = 'LiveXFaceApiError'
        this.code = code
        this.statusCode = statusCode
        this.requestId = requestId
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
