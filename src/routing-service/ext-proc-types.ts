// --- Request types (received from ALB) ---

export interface HeaderValue {
  key: string;
  rawValue?: Buffer;
  value?: string;
}

export interface HttpHeaders {
  headers?: {
    headers?: HeaderValue[];
  };
  endOfStream?: boolean;
}

export interface ProcessingRequest {
  requestHeaders?: HttpHeaders;
}

// --- Response types (sent back to ALB) ---

export interface HeaderValueOption {
  header: HeaderValue;
  appendAction?: "APPEND_IF_EXISTS_OR_ADD" | "OVERWRITE_IF_EXISTS_OR_ADD";
}

export interface HeaderMutation {
  setHeaders?: HeaderValueOption[];
  removeHeaders?: string[];
}

export interface CommonResponse {
  headerMutation?: HeaderMutation;
  status?: "CONTINUE" | "CONTINUE_AND_REPLACE";
  /** Re-run route selection after mutating a header used by the data plane's route table. */
  clearRouteCache?: boolean;
}

export interface ImmediateResponse {
  status?: { code: number };
  headers?: HeaderMutation;
  // N40: a middleware-authored body can be BINARY. A `string` body forced a UTF-8 round-trip
  // (`await response.text()` here, `TextEncoder.encode` in server.ts) that replaced every byte
  // >= 0x80 with U+FFFD, so the bytes on the wire no longer matched what middleware returned.
  // Byte bodies pass through untouched; strings stay supported for the text responses this tier
  // authors itself.
  body?: string | Uint8Array;
  grpcStatus?: { status: number };
}

export interface HeadersResponse {
  response?: CommonResponse;
}

export interface ProcessingResponse {
  requestHeaders?: HeadersResponse;
  immediateResponse?: ImmediateResponse;
}
