import { describe, expect, it } from "vitest";
import {
  detectImageContentType,
  negotiateImageFormat,
  resizeForRequestedWidth,
} from "../../src/pool-server/image-utils.js";

// A minimal fake honoring the sharp resize contract: `withoutEnlargement: true`
// clamps the target to the source dimensions. This lets the test assert the
// no-upscale POLICY behaviorally — if the option were dropped or renamed, the
// fake would upscale and the assertions below would fail.
function fakeSharpPipeline(source: { width: number; height: number }) {
  return {
    output: { ...source },
    resize(
      width: number | undefined,
      _height: undefined,
      options: { withoutEnlargement?: boolean },
    ) {
      if (width !== undefined) {
        const target = options.withoutEnlargement ? Math.min(width, source.width) : width;
        this.output = {
          width: target,
          height: Math.round((target / source.width) * source.height),
        };
      }
      return this;
    },
  };
}

describe("image resize no-upscale policy", () => {
  it("never enlarges a smaller source for a wider srcset candidate", () => {
    const pipeline = resizeForRequestedWidth(fakeSharpPipeline({ width: 400, height: 400 }), 640);
    expect(pipeline.output.width).toBe(400);
    expect(pipeline.output.height).toBe(400);
  });

  it("downscales a larger source to the requested width, preserving aspect", () => {
    const pipeline = resizeForRequestedWidth(fakeSharpPipeline({ width: 1200, height: 600 }), 640);
    expect(pipeline.output.width).toBe(640);
    expect(pipeline.output.height).toBe(320);
  });

  it("leaves dimensions alone when no width is requested", () => {
    const pipeline = resizeForRequestedWidth(
      fakeSharpPipeline({ width: 400, height: 300 }),
      undefined,
    );
    expect(pipeline.output).toEqual({ width: 400, height: 300 });
  });
});

describe("image format negotiation", () => {
  it("prefers avif when the client accepts it", () => {
    expect(negotiateImageFormat("image/avif,image/webp,*/*", "image/png")).toEqual({
      encode: "avif",
      contentType: "image/avif",
    });
  });

  it("prefers webp when accepted and avif is not", () => {
    expect(negotiateImageFormat("image/webp,*/*", "image/jpeg")).toEqual({
      encode: "webp",
      contentType: "image/webp",
    });
  });

  it("preserves a png source rather than forcing jpeg", () => {
    expect(negotiateImageFormat("*/*", "image/png")).toEqual({
      encode: "png",
      contentType: "image/png",
    });
  });

  it("passes gif/svg sources through untouched", () => {
    expect(negotiateImageFormat("*/*", "image/gif")).toEqual({
      encode: "passthrough",
      contentType: "image/gif",
    });
    expect(negotiateImageFormat("*/*", "image/svg+xml")).toEqual({
      encode: "passthrough",
      contentType: "image/svg+xml",
    });
  });

  it("checks gif/svg passthrough BEFORE Accept negotiation (next start order)", () => {
    // Next checks SVG + animated sources FIRST: a browser sending
    // `image/avif,image/webp` must not get an animated GIF re-encoded to a static
    // first frame, nor an SVG rasterized. Accept previously won, pinning the
    // wrong behavior.
    expect(negotiateImageFormat("image/avif,image/webp,*/*", "image/gif")).toEqual({
      encode: "passthrough",
      contentType: "image/gif",
    });
    expect(negotiateImageFormat("image/webp", "image/svg+xml")).toEqual({
      encode: "passthrough",
      contentType: "image/svg+xml",
    });
  });

  it("falls back to jpeg for other sources", () => {
    expect(negotiateImageFormat("", "image/jpeg")).toEqual({
      encode: "jpeg",
      contentType: "image/jpeg",
    });
  });
});

describe("image content-type sniffing (next start parity: detectContentType)", () => {
  // Next's optimizer derives the SOURCE format from the bytes, never from the URL
  // or the upstream Content-Type header. These signatures mirror
  // next/dist/server/image-optimizer.js detectContentType.
  const ONE_PIXEL_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  it("detects png/jpeg/gif from magic bytes", () => {
    expect(detectImageContentType(ONE_PIXEL_PNG)).toBe("image/png");
    expect(detectImageContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
    expect(detectImageContentType(Buffer.from("GIF89a\x2a\x2a"))).toBe("image/gif");
  });

  it("detects webp and avif with wildcard length bytes", () => {
    expect(
      detectImageContentType(
        Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]),
      ),
    ).toBe("image/webp");
    expect(
      detectImageContentType(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif")])),
    ).toBe("image/avif");
  });

  it("detects svg by both document openings (the dangerouslyAllowSVG gate depends on this)", () => {
    expect(detectImageContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      "image/svg+xml",
    );
    expect(detectImageContentType(Buffer.from('<?xml version="1.0"?><svg/>'))).toBe("image/svg+xml");
  });

  it("detects ico", () => {
    expect(detectImageContentType(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]))).toBe("image/x-icon");
  });

  it("returns null for unrecognized bytes so callers can fall back", () => {
    expect(detectImageContentType(Buffer.from("not an image"))).toBeNull();
    expect(detectImageContentType(Buffer.alloc(0))).toBeNull();
  });
});
