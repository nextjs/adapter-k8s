import type { ProcessingResponse, HeaderValueOption } from './ext-proc-types.js';

export interface HeaderMutationEntry {
  key: string;
  value: string;
}

export function buildImmediateResponse(
  statusCode: number,
  headers: Record<string, string>,
  body?: string,
): ProcessingResponse {
  const setHeaders: HeaderValueOption[] = Object.entries(headers).map(
    ([key, value]) => ({
      header: { key, value },
      appendAction: 'OVERWRITE_IF_EXISTS_OR_ADD' as const,
    }),
  );
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
): ProcessingResponse {
  const setHeaders: HeaderValueOption[] = mutations.map(({ key, value }) => ({
    header: { key, value },
    appendAction: 'OVERWRITE_IF_EXISTS_OR_ADD' as const,
  }));
  return {
    requestHeaders: {
      response: {
        headerMutation: { setHeaders },
        status: 'CONTINUE',
      },
    },
  };
}
