import type { ProcessingResponse, HeaderValueOption } from "./ext-proc-types.js";

export interface HeaderMutationEntry {
  key: string;
  value: string;
}

export function buildImmediateResponse(
  statusCode: number,
  headers: Record<string, string>,
  // N40: `Uint8Array` for a middleware-authored (possibly binary) body — see
  // ext-proc-types.ts. A string body is still accepted for this tier's own text responses.
  body?: string | Uint8Array,
  setCookies?: string[],
): ProcessingResponse {
  const setHeaders: HeaderValueOption[] = Object.entries(headers).map(([key, value]) => ({
    header: { key, value },
    appendAction: "OVERWRITE_IF_EXISTS_OR_ADD" as const,
  }));
  // Set-Cookie can legitimately repeat. A Record<string,string> can't represent
  // that, so cookies are passed separately and each emitted as its own entry
  // with APPEND (not OVERWRITE) so they don't clobber one another.
  if (setCookies) {
    for (const cookie of setCookies) {
      setHeaders.push({
        header: { key: "set-cookie", value: cookie },
        appendAction: "APPEND_IF_EXISTS_OR_ADD" as const,
      });
    }
  }
  const response: ProcessingResponse = {
    immediateResponse: {
      status: { code: statusCode },
      headers: { setHeaders },
    },
  };
  if (body !== undefined) {
    response.immediateResponse!.body = body;
  }
  return response;
}

export function buildHeaderMutationResponse(
  mutations: HeaderMutationEntry[],
  removeHeaders?: string[],
): ProcessingResponse {
  const setHeaders: HeaderValueOption[] = mutations.map(({ key, value }) => ({
    header: { key, value },
    appendAction: "OVERWRITE_IF_EXISTS_OR_ADD" as const,
  }));
  const headerMutation: { setHeaders: HeaderValueOption[]; removeHeaders?: string[] } = {
    setHeaders,
  };
  // removeHeaders clears any client-spoofed internal dispatch headers that this response
  // does NOT itself set (e.g. x-route-matches on a route with no dynamic params). Without
  // this a client could smuggle a dispatch header past the extension since setHeaders only
  // overwrites the keys it lists.
  if (removeHeaders && removeHeaders.length > 0) {
    headerMutation.removeHeaders = removeHeaders;
  }
  return {
    requestHeaders: {
      response: {
        headerMutation,
        status: "CONTINUE",
      },
    },
  };
}
