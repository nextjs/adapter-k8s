/**
 * Decode a wire pathname the same way Next 16.3 prepares requestMeta.resolvedPathname.
 *
 * Decoding each segment exposes UTF-8 text while re-encoding path delimiters and already encoded
 * delimiter spellings. A plain decodeURI is not equivalent: it maps both `%252F` and `%2F` to
 * `%2F`, which aliases two distinct routes and cache keys.
 */
export function decodeNextPathname(pathname: string): string {
  try {
    return pathname
      .split("/")
      .map((segment) =>
        decodeURIComponent(segment).replace(/([/#?]|%(2f|23|3f|5c))/gi, (value) =>
          encodeURIComponent(value),
        ),
      )
      .join("/");
  } catch {
    // Next keeps the encoded pathname when any segment is malformed.
    return pathname;
  }
}
