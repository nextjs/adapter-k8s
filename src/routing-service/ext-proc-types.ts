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
}

export interface ImmediateResponse {
  status?: { code: number };
  headers?: HeaderMutation;
  body?: string;
  grpcStatus?: { status: number };
}

export interface HeadersResponse {
  response?: CommonResponse;
}

export interface ProcessingResponse {
  requestHeaders?: HeadersResponse;
  immediateResponse?: ImmediateResponse;
}
