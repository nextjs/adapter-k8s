export type ParsedDispatchField<T> =
  | { readonly ok: true; readonly value: T | undefined }
  | { readonly ok: false };

function absent<T>(): ParsedDispatchField<T> {
  return { ok: true, value: undefined };
}

function invalid<T>(): ParsedDispatchField<T> {
  return { ok: false };
}

function parseJsonObject(raw: unknown): ParsedDispatchField<Record<string, unknown>> {
  if (raw === undefined) return absent();
  if (typeof raw !== "string") return invalid();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return invalid();
  }
}

/** Parse the JSON wire shape shared by response headers and middleware request headers. */
export function parseDispatchHeaderMap(raw: unknown): ParsedDispatchField<Headers> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return invalid();
  if (parsed.value === undefined) return absent();
  try {
    const headers = new Headers();
    for (const [name, item] of Object.entries(parsed.value)) {
      if (typeof item === "string") {
        headers.set(name, item);
      } else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
        for (const entry of item) headers.append(name, entry);
      } else {
        return invalid();
      }
    }
    return { ok: true, value: headers };
  } catch {
    // Headers rejects invalid names and values. Treat that as a corrupt routing verdict too.
    return invalid();
  }
}

export function parseDispatchRouteMatches(
  raw: unknown,
): ParsedDispatchField<Record<string, string>> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return invalid();
  if (parsed.value === undefined) return absent();
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed.value)) {
    if (typeof item !== "string") return invalid();
    record[key] = item;
  }
  return { ok: true, value: record };
}

export function parseDispatchInvocationQuery(
  raw: unknown,
): ParsedDispatchField<Record<string, string | string[]>> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return invalid();
  if (parsed.value === undefined) return absent();
  const query: Record<string, string | string[]> = {};
  for (const [key, item] of Object.entries(parsed.value)) {
    if (typeof item === "string") query[key] = item;
    else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
      query[key] = item;
    } else {
      return invalid();
    }
  }
  return { ok: true, value: query };
}

export function parseDispatchDeadline(raw: unknown): ParsedDispatchField<number> {
  if (raw === undefined) return absent();
  if (typeof raw !== "string") return invalid();
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? { ok: true, value } : invalid();
}
