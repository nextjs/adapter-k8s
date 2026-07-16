import { describe, expect, it, vi } from "vitest";
import { resizeForRequestedWidth } from "../../src/pool-server/image-utils.js";

describe("image resize policy", () => {
  it("requests the target width without enlarging a smaller source", () => {
    const resized = { marker: "pipeline" };
    const resize = vi.fn().mockReturnValue(resized);

    expect(resizeForRequestedWidth({ resize }, 640)).toBe(resized);
    expect(resize).toHaveBeenCalledWith(640, undefined, { withoutEnlargement: true });
  });
});

