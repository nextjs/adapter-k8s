import type { CacheEntry } from "./types.js";

/**
 * Drain a cache entry's value stream to a Buffer for storage, WITHOUT consuming the copy
 * Next still needs for the in-flight response. Mirrors Next's own handlers (`default.js`,
 * `resume-data-cache/cache-store.js`): `tee` the stream, hand one branch back to the entry
 * (so the caller's read still works) and drain the other.
 *
 * Returns `null` if the stream errors or delivers partially — a partial entry must be
 * discarded (treated as a miss), never cached.
 */
export async function drainEntryValue(entry: CacheEntry): Promise<Buffer | null> {
  const [ours, theirs] = entry.value.tee();
  entry.value = theirs;
  try {
    const reader = ours.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Reconstruct a fresh `ReadableStream` from stored bytes. Every `get` gets its own stream —
 * a stored buffer is never handed out as a shared/consumed stream.
 */
export function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}
