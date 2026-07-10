export async function readWebBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel("body exceeds configured size limit");
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.length > 0 ? Buffer.concat(chunks, total) : Buffer.alloc(0);
}
