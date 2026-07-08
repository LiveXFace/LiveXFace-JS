export class SerupaApiError extends Error {
    public readonly code: string
    public readonly statusCode: number
    public readonly requestId?: string

    constructor(code: string, message: string, statusCode: number, requestId?: string) {
        super(message)
        this.name = 'SerupaApiError'
        this.code = code
        this.statusCode = statusCode
        this.requestId = requestId
        Object.setPrototypeOf(this, SerupaApiError.prototype)
    }
}

export class SerupaNetworkError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message)
        this.name = 'SerupaNetworkError'
        Object.setPrototypeOf(this, SerupaNetworkError.prototype)
    }
}
