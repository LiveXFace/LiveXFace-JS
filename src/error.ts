export class IdemityApiError extends Error {
    public readonly code: string
    public readonly statusCode: number
    public readonly requestId?: string

    constructor(code: string, message: string, statusCode: number, requestId?: string) {
        super(message)
        this.name = 'IdemityApiError'
        this.code = code
        this.statusCode = statusCode
        this.requestId = requestId
        Object.setPrototypeOf(this, IdemityApiError.prototype)
    }
}

export class IdemityNetworkError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message)
        this.name = 'IdemityNetworkError'
        Object.setPrototypeOf(this, IdemityNetworkError.prototype)
    }
}
