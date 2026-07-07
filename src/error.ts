export class FRApiError extends Error {
    public readonly code: string
    public readonly statusCode: number
    public readonly requestId?: string

    constructor(code: string, message: string, statusCode: number, requestId?: string) {
        super(message)
        this.name = 'FRApiError'
        this.code = code
        this.statusCode = statusCode
        this.requestId = requestId
        Object.setPrototypeOf(this, FRApiError.prototype)
    }
}

export class FRNetworkError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message)
        this.name = 'FRNetworkError'
        Object.setPrototypeOf(this, FRNetworkError.prototype)
    }
}
