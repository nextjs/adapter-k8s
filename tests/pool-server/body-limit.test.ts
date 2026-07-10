import { describe, expect, it, vi } from "vitest";
import { readWebBodyWithLimit } from "../../src/pool-server/body-limit.js";

describe("readWebBodyWithLimit", () => {
  it("returns a body that is exactly at the limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });

    await expect(readWebBodyWithLimit(body, 4)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("cancels a chunked body as soon as it exceeds the limit", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel,
    });

    await expect(readWebBodyWithLimit(body, 5)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
