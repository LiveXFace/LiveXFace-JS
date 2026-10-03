/**
 * The API contract (`info.version` of `/openapi.json`) this SDK release is
 * validated against. Kept equal to the CONTRACT_VERSION file by the tests.
 */
export const CONTRACT_VERSION = '1.0.0'

export { LiveXFace, FacesResource, generateIdempotencyKey } from './client'
export { LiveXFaceApiError, LiveXFaceNetworkError } from './error'
export type {
    LiveXFaceConfig,
    APIResponse,
    APIError,
    Face,
    RegisterFaceInput,
    IdempotencyOptions,
    ListFacesInput,
    ListFacesResponse,
    VerifyInput,
    VerifyResult,
    IdentifyMatch,
    IdentifyInput,
    IdentifyResult,
    DetectedFace,
    CompareInput,
    LivenessInput,
    LivenessResult,
    ActiveLivenessChallenge,
    ActiveLivenessChallenges,
    ActiveLivenessResult,
    BatchRegisterItem,
    BatchFaceResult,
    BatchResponse,
    BatchDeleteResult,
    BatchDeleteResponse,
    FaceBBox,
    ImageSize,
    HeadPose,
    EmotionResult,
    DetectionResult,
    FaceAttributes,
    AttributesInput,
    AttributesResult,
    BatchJobStatus,
    BatchJobResult,
    BatchJob,
} from './types'
