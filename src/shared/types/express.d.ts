// export {} makes this file a module, so declare module acts as an augmentation
// (not a replacement) of the existing express-serve-static-core types.
export {};

declare module 'express-serve-static-core' {
  interface Request {
    /** Authenticated user ID (attached by JWT/API-key middleware when valid) */
    userId?: string;
    /** Raw request body buffer (captured before JSON parsing for HMAC verification) */
    rawBody?: Buffer;
    /** Whether the request passed optional API-key authentication */
    authenticated?: boolean;
  }
}
