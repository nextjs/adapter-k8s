// A failed delete is idempotent success only when the provider proves the resource is absent.
// Auth, connectivity and quota errors can contain misleading 404/not-found text, so those
// markers veto the absence classification.
const NOT_GONE_MARKERS = [
  "permission",
  "forbidden",
  "unauthorized",
  "unauthenticated",
  "credential",
  "invalid_grant",
  "dial tcp",
  "no such host",
  "connection refused",
  "unable to connect",
  "i/o timeout",
  "timed out",
  "quota",
  "rate limit",
  "service unavailable",
];

export function hasDeletionFailureMarker(stderr: string): boolean {
  const message = stderr.toLowerCase();
  return NOT_GONE_MARKERS.some((marker) => message.includes(marker));
}

export function isAlreadyGoneError(stderr: string): boolean {
  const message = stderr.toLowerCase();
  if (hasDeletionFailureMarker(message)) return false;
  return (
    message.includes("notfound") ||
    message.includes("not_found") ||
    message.includes("not found") ||
    message.includes("does not exist") ||
    message.includes("was not found") ||
    message.includes("release: not found")
  );
}
