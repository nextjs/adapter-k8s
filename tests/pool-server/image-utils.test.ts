import { describe, expect, it } from "vitest";
import {
  detectImageContentType,
  imageCacheControl,
  imageContentDisposition,
  imageDownloadFileName,
  imageEtag,
  imageMaxAge,
  isAnimatedImage,
  isOptimizableImageContentType,
  negotiateImageFormat,
  negotiateImageMimeType,
  resizeForRequestedWidth,
  validateImageSizeAndQuality,
  DEFAULT_IMAGE_DEVICE_SIZES,
  DEFAULT_IMAGE_QUALITIES,
  DEFAULT_IMAGE_SIZES,
} from "../../src/pool-server/image-utils.js";

// Minimal but REAL image byte streams, each cross-checked against the upstream modules
// Next actually calls (next/dist/compiled/is-animated) before being pinned here, and the
// GIFs additionally confirmed by sharp reporting pages=1 / pages=2. See the block comment
// on isAnimatedImage for why the sniffer is a port rather than a heuristic.
const STATIC_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAAKAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64",
);
const ANIMATED_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAAKAAAALAAAAAABAAEAAAICRAEAIfkEAAoAAAAsAAAAAAEAAQAAAgJEAQA7",
  "base64",
);
// APNG: acTL → fcTL → IDAT → fcTL → fdAT (upstream requires all three markers, in order).
const ANIMATED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAAAAAAAAAACGFjVEwAAAACAAAAAAAAAAAAAAAaZmNUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAtJREFUeJxjYAACAAAFAAEAAAAAAAAAGmZjVEwAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPZmRBVAAAAAJ4nGNgAAIAAAUAAQAAAAAAAAAASUVORAAAAAA=",
  "base64",
);
const STATIC_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAAAAAAAAAAC0lEQVR4nGNgAAIAAAUAAQAAAAAAAAAASUVORAAAAAA=",
  "base64",
);
// acTL present but no fdAT — an animation control chunk alone is NOT an animation.
const ACTL_ONLY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAAAAAAAAAACGFjVEwAAAACAAAAAAAAAAAAAAAaZmNUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAtJREFUeJxjYAACAAAFAAEAAAAAAAAAAElFTkQAAAAA",
  "base64",
);
const ANIMATED_WEBP = Buffer.from(
  "UklGRjwAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAAAAAAAAABBTk1GEAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "base64",
);
const STATIC_WEBP = Buffer.from("UklGRhwAAABXRUJQVlA4IBAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64");

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
  const AVIF_AND_WEBP = ["image/avif", "image/webp"];

  it("honors images.formats: the DEFAULT is webp-only, so avif is never served unasked", () => {
    // The regression this pins: negotiation ignored images.formats and picked AVIF for any
    // Accept that mentioned it. `next start` on the upstream image-optimizer fixture with
    // the default config answers `/_next/image?url=/test.png&w=384&q=75` +
    // `Accept: image/avif,image/webp,…` with 6224 B of image/webp; the adapter answered
    // 3256 B of image/avif. Verified 2026-07-24 against Next 16.2.10.
    expect(
      negotiateImageFormat("image/avif,image/webp,image/apng,*/*;q=0.8", "image/png", {
        sourceBytes: STATIC_PNG,
      }),
    ).toEqual({ encode: "webp", contentType: "image/webp" });
    // Opting in restores AVIF — and the client's own ordering rules pick it.
    expect(
      negotiateImageFormat("image/avif,image/webp,image/apng,*/*;q=0.8", "image/png", {
        formats: AVIF_AND_WEBP,
        sourceBytes: STATIC_PNG,
      }),
    ).toEqual({ encode: "avif", contentType: "image/avif" });
  });

  it("negotiates within the configured list only", () => {
    // avif configured but not accepted ⇒ nothing negotiated ⇒ source format preserved.
    expect(
      negotiateImageFormat("image/webp,*/*", "image/png", {
        formats: ["image/avif"],
        sourceBytes: STATIC_PNG,
      }),
    ).toEqual({ encode: "png", contentType: "image/png" });
    expect(negotiateImageFormat("image/webp,*/*", "image/jpeg")).toEqual({
      encode: "webp",
      contentType: "image/webp",
    });
  });

  it("preserves a png source rather than forcing jpeg", () => {
    expect(negotiateImageFormat("*/*", "image/png", { sourceBytes: STATIC_PNG })).toEqual({
      encode: "png",
      contentType: "image/png",
    });
  });

  it("passes svg through untouched", () => {
    expect(negotiateImageFormat("*/*", "image/svg+xml")).toEqual({
      encode: "passthrough",
      contentType: "image/svg+xml",
    });
  });

  it("re-encodes a PROVEN-STATIC gif but never an animated one", () => {
    // `next start` re-encodes a static GIF (upstream fixture test.gif: 2301 B source →
    // 916 B webp at w=384/q=75, byte-identical ETag to ours) while returning an animated
    // GIF verbatim. Blanket GIF passthrough was the previous, safe-but-divergent behavior.
    expect(
      negotiateImageFormat("image/avif,image/webp,*/*", "image/gif", {
        sourceBytes: STATIC_GIF,
      }),
    ).toEqual({ encode: "webp", contentType: "image/webp" });
    expect(
      negotiateImageFormat("image/avif,image/webp,*/*", "image/gif", {
        sourceBytes: ANIMATED_GIF,
      }),
    ).toEqual({ encode: "passthrough", contentType: "image/gif" });
    // No negotiated format: Next keeps GIF as GIF (re-encoded), not JPEG.
    expect(negotiateImageFormat("*/*", "image/gif", { sourceBytes: STATIC_GIF })).toEqual({
      encode: "gif",
      contentType: "image/gif",
    });
  });

  it("treats every animatable source as animated when the bytes are unavailable", () => {
    // Fail-safe direction: without the bytes the animation question is unanswerable, and
    // flattening an animation is destructive while serving it verbatim is not.
    for (const type of ["image/gif", "image/png", "image/webp"]) {
      expect(negotiateImageFormat("image/avif,image/webp", type).encode).toBe("passthrough");
    }
  });

  it("passes animated PNG/WebP through even when the client accepts avif/webp", () => {
    expect(
      negotiateImageFormat("image/avif,image/webp,*/*", "image/png", {
        sourceBytes: ANIMATED_PNG,
        formats: AVIF_AND_WEBP,
      }),
    ).toEqual({ encode: "passthrough", contentType: "image/png" });
    expect(
      negotiateImageFormat("image/avif,image/webp,*/*", "image/webp", {
        sourceBytes: ANIMATED_WEBP,
        formats: AVIF_AND_WEBP,
      }),
    ).toEqual({ encode: "passthrough", contentType: "image/webp" });
  });

  it("checks passthrough BEFORE Accept negotiation (next start order)", () => {
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

  it("passes Next's BYPASS_TYPES through, even when the client accepts avif/webp", () => {
    // Regression: only gif/svg bypassed, so an ICO or BMP was handed to sharp — which
    // cannot DECODE either ("Input buffer contains unsupported image format") — and the
    // request 502'd. `next start` returns the source bytes with the source content type
    // (verified against next start on the next-image-legacy/default fixture: /test.ico →
    // 200 image/x-icon byte-identical, /test.bmp → 200 image/bmp byte-identical). This
    // was the whole `[LOADING]` cluster: the browser never fired load for the .ico img.
    for (const type of [
      "image/x-icon",
      "image/x-icns",
      "image/bmp",
      "image/jxl",
      "image/heic",
      "image/svg+xml",
    ]) {
      expect(negotiateImageFormat("image/avif,image/webp,image/*,*/*;q=0.8", type)).toEqual({
        encode: "passthrough",
        contentType: type,
      });
    }
  });

  it("still optimizes formats Next does NOT bypass (tiff, static webp/png, avif, jpeg)", () => {
    // BYPASS_TYPES is a closed list — sharp decodes these fine and next start re-encodes
    // them, so a blanket "unknown ⇒ passthrough" would be the wrong direction.
    const staticBytes: Record<string, Buffer | undefined> = {
      "image/webp": STATIC_WEBP,
      "image/png": STATIC_PNG,
    };
    for (const type of ["image/tiff", "image/webp", "image/avif", "image/jpeg", "image/png"]) {
      const sourceBytes = staticBytes[type];
      expect(
        negotiateImageFormat("image/avif,image/webp", type, {
          formats: ["image/avif", "image/webp"],
          ...(sourceBytes ? { sourceBytes } : {}),
        }).encode,
      ).toBe("avif");
    }
  });

  it("compares on the bare media type, so a parameter can't smuggle a type past the check", () => {
    expect(negotiateImageFormat("image/avif", "image/bmp; charset=binary").encode).toBe(
      "passthrough",
    );
    expect(negotiateImageFormat("*/*", "IMAGE/PNG; q=1", { sourceBytes: STATIC_PNG }).encode).toBe(
      "png",
    );
  });
});

describe("Accept negotiation within images.formats (port of @hapi/accept + Next's guard)", () => {
  const BOTH = ["image/avif", "image/webp"];

  it("returns nothing for a wildcard-only Accept, so the source format is preserved", () => {
    // Not an omission: hapi answers a wildcard entry with a format the header does NOT
    // mention, and Next's `accept.includes(...)` guard then rejects it. Verified against
    // `next start`: `?url=/test.png&w=384&q=75` with `Accept: */*` ⇒ 200 image/png (5513 B),
    // never webp.
    expect(negotiateImageMimeType("*/*", BOTH)).toBeNull();
    expect(negotiateImageMimeType("image/*", BOTH)).toBeNull();
    expect(negotiateImageMimeType("", BOTH)).toBeNull();
    expect(negotiateImageMimeType("text/html", BOTH)).toBeNull();
  });

  it("obeys the CLIENT's preference order, not the config's", () => {
    // At equal q hapi sorts alphabetically, so avif wins for both config orderings.
    expect(negotiateImageMimeType("image/webp,image/avif", BOTH)).toBe("image/avif");
    expect(negotiateImageMimeType("image/webp,image/avif", ["image/webp", "image/avif"])).toBe(
      "image/avif",
    );
    // …but an explicit q beats alphabetical order.
    expect(negotiateImageMimeType("image/avif;q=0.5,image/webp", BOTH)).toBe("image/webp");
    // q=0 removes an entry entirely.
    expect(negotiateImageMimeType("image/avif;q=0,image/webp", BOTH)).toBe("image/webp");
    expect(negotiateImageMimeType("image/webp;q=0", BOTH)).toBeNull();
  });

  it("lets a higher-q wildcard suppress a lower-q explicit format (upstream behavior)", () => {
    expect(negotiateImageMimeType("*/*,image/webp;q=0.5", BOTH)).toBeNull();
    // …unless every matching format is already mentioned, in which case the wildcard
    // contributes nothing and scanning continues to the explicit entries.
    expect(negotiateImageMimeType("*/*,image/avif;q=0.5,image/webp;q=0.5", BOTH)).toBe(
      "image/avif",
    );
  });

  it("mirrors the guard's case-sensitivity (an uppercase Accept negotiates nothing)", () => {
    expect(negotiateImageMimeType("IMAGE/WEBP", ["image/webp"])).toBeNull();
  });

  it("negotiates nothing when formats is empty", () => {
    expect(negotiateImageMimeType("image/avif,image/webp", [])).toBeNull();
  });
});

describe("animation sniffing (port of is-animated, which Next's optimizer calls)", () => {
  it("classifies multi-frame GIF / APNG / animated WebP as animated", () => {
    expect(isAnimatedImage(ANIMATED_GIF)).toBe(true);
    expect(isAnimatedImage(ANIMATED_PNG)).toBe(true);
    expect(isAnimatedImage(ANIMATED_WEBP)).toBe(true);
  });

  it("classifies single-frame GIF / PNG / WebP as static", () => {
    expect(isAnimatedImage(STATIC_GIF)).toBe(false);
    expect(isAnimatedImage(STATIC_PNG)).toBe(false);
    expect(isAnimatedImage(STATIC_WEBP)).toBe(false);
    // An acTL chunk without the fdAT frame data is not an animation (upstream needs all
    // three of acTL/IDAT/fdAT in order).
    expect(isAnimatedImage(ACTL_ONLY_PNG)).toBe(false);
  });

  it("answers false for formats that cannot be animated", () => {
    expect(isAnimatedImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(isAnimatedImage(Buffer.from([0x42, 0x4d, 0x36]))).toBe(false);
    expect(isAnimatedImage(Buffer.from("<svg/>"))).toBe(false);
  });

  it("never throws on truncated or garbage bytes (upstream throws on a short APNG)", () => {
    // The APNG chunk walk reads a 4-byte length; upstream raises ERR_OUT_OF_RANGE on a
    // truncated tail, which here would surface as a 500 on a request `next start` answers.
    // A parse that cannot complete answers "not proven animated" and lets sharp validate.
    for (const source of [ANIMATED_GIF, ANIMATED_PNG, ANIMATED_WEBP]) {
      for (let length = 0; length <= source.length; length++) {
        expect(() => isAnimatedImage(source.subarray(0, length))).not.toThrow();
      }
    }
    expect(isAnimatedImage(Buffer.alloc(0))).toBe(false);
    expect(isAnimatedImage(Buffer.from("GIF"))).toBe(false);
  });
});

describe("optimizer response headers (next start parity)", () => {
  it("hashes the response bytes into Next's ETag shape: unquoted base64url(sha256)", () => {
    // Byte-identical to `next start` for the same optimized output — verified against the
    // upstream image-optimizer fixture (24 of 24 re-encoded responses matched, e.g.
    // /test.png w=384 q=75 webp ⇒ LVreQhQZrY_xWkDWIGekQujacTs-j6mKSZr5cg87Q6w).
    expect(imageEtag(Buffer.from("hello"))).toBe("LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
    expect(imageEtag(Buffer.from("hello"))).not.toContain('"');
    // Content-addressed, so every replica answers the same URL with the same validator.
    expect(imageEtag(Buffer.from("a"))).not.toBe(imageEtag(Buffer.from("b")));
  });

  it("builds Next's Cache-Control, immutable for content-addressed static media", () => {
    expect(imageCacheControl(14400, false)).toBe("public, max-age=14400, must-revalidate");
    expect(imageCacheControl(5, false)).toBe("public, max-age=5, must-revalidate");
    expect(imageCacheControl(14400, true)).toBe("public, max-age=315360000, immutable");
  });

  it("raises max-age to the upstream's when the upstream asks for longer", () => {
    expect(imageMaxAge(14400, null)).toBe(14400);
    expect(imageMaxAge(14400, "public, max-age=100")).toBe(14400);
    expect(imageMaxAge(14400, "public, max-age=99999")).toBe(99999);
    expect(imageMaxAge(14400, "public, s-maxage=88888, max-age=1")).toBe(88888);
    // Next reads ONLY s-maxage/max-age, so an upstream no-store does not make the
    // optimizer response uncacheable.
    expect(imageMaxAge(14400, "no-store")).toBe(14400);
    // An untrusted upstream value that is not a plain non-negative integer is ignored.
    expect(imageMaxAge(14400, "max-age=abc")).toBe(14400);
    expect(imageMaxAge(14400, "max-age=999999999999999999999")).toBe(14400);
  });

  it("names the download after the source file with the OUTPUT extension", () => {
    expect(imageDownloadFileName("/test.png", "image/webp")).toBe("test.webp");
    expect(imageDownloadFileName("/dir/photo.JPG", "image/avif")).toBe("photo.avif");
    expect(imageDownloadFileName("https://h/a/b/pic.png?v=2", "image/webp")).toBe("pic.webp");
    expect(imageDownloadFileName("/png-as-octet-stream", "image/webp")).toBe(
      "png-as-octet-stream.webp",
    );
    // Unknown output type: keep the source segment rather than invent an extension.
    expect(imageDownloadFileName("/x.bin", "image/does-not-exist")).toBe("x.bin");
  });

  it("formats Content-Disposition exactly like the `content-disposition` module", () => {
    expect(imageContentDisposition("/test.png", "image/webp", "attachment")).toBe(
      'attachment; filename="test.webp"',
    );
    expect(imageContentDisposition("/test.png", "image/webp", "inline")).toBe(
      'inline; filename="test.webp"',
    );
    // Non-Latin-1 names get the RFC 5987 pair, with `?` standing in for the unrepresentable
    // characters in the quoted form. Byte-for-byte what `next start` sent for this fixture.
    expect(imageContentDisposition("/äöüščří.png", "image/webp", "attachment")).toBe(
      "attachment; filename=\"äöü???í.webp\"; filename*=UTF-8''%C3%A4%C3%B6%C3%BC%C5%A1%C4%8D%C5%99%C3%AD.webp",
    );
  });

  it("cannot be used to inject a response header (sanitize at consumption)", () => {
    // The filename is request-controlled. Control characters can never reach the quoted
    // form (they are replaced by `?`) and the extended form is percent-encoded, so no CR,
    // LF or DEL survives — independent of any earlier 400.
    const header = imageContentDisposition("/a\r\nX-Evil: 1.png", "image/webp", "attachment");
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain("%0D%0A");
    // Quotes and backslashes are escaped rather than closing the quoted string early
    // (an all-Latin-1 name needs no extended form, exactly as upstream emits it).
    expect(imageContentDisposition('/a"b.png', "image/webp", "attachment")).toBe(
      'attachment; filename="a\\"b.webp"',
    );
    expect(imageContentDisposition("/a\\b.png", "image/webp", "attachment")).toBe(
      'attachment; filename="a\\\\b.webp"',
    );
    // Every byte of the header is transmissible: Node rejects a value outside
    // \t\x20-\x7e\x80-\xff, which would turn a crafted name into a 500.
    for (const name of ["/\x7f.png", "/\x01\x02.png", "/ line.png", "/日本語.png"]) {
      const value = imageContentDisposition(name, "image/webp", "attachment");
      expect(value).not.toMatch(/[^\t\x20-\x7e\x80-\xff]/);
    }
  });
});

describe("non-image sources (next start parity: 400, never sharp)", () => {
  it("rejects anything that is not an image/* type", () => {
    // next start: `400 The requested resource isn't a valid image.` — the adapter used to
    // hand these to sharp and answer 502 (verified against next start 2026-07-24 for a
    // text/plain and a text/html source).
    expect(isOptimizableImageContentType("text/plain; charset=utf-8")).toBe(false);
    expect(isOptimizableImageContentType("text/html; charset=utf-8")).toBe(false);
    expect(isOptimizableImageContentType("application/pdf")).toBe(false);
    expect(isOptimizableImageContentType("application/octet-stream")).toBe(false);
    expect(isOptimizableImageContentType("")).toBe(false);
    // Next also rejects a comma-bearing type (a multi-value header leaking through).
    expect(isOptimizableImageContentType("image/png,image/gif")).toBe(false);
  });

  it("accepts image/* with or without parameters", () => {
    expect(isOptimizableImageContentType("image/png")).toBe(true);
    expect(isOptimizableImageContentType("image/svg+xml; charset=utf-8")).toBe(true);
    expect(isOptimizableImageContentType("IMAGE/X-ICON")).toBe(true);
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
      detectImageContentType(
        Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif")]),
      ),
    ).toBe("image/avif");
  });

  it("detects svg by both document openings (the dangerouslyAllowSVG gate depends on this)", () => {
    expect(detectImageContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      "image/svg+xml",
    );
    expect(detectImageContentType(Buffer.from('<?xml version="1.0"?><svg/>'))).toBe(
      "image/svg+xml",
    );
  });

  it("detects ico", () => {
    expect(detectImageContentType(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]))).toBe(
      "image/x-icon",
    );
  });

  it("detects the formats sharp cannot decode (they must reach the bypass path, not sharp)", () => {
    // A format that sniffs as null falls through to the URL-extension guess and then into
    // sharp, which throws → 502. `/test.bmp` did exactly that (guessed
    // application/octet-stream). These four MUST be recognized for the bypass to fire.
    expect(detectImageContentType(Buffer.from([0x42, 0x4d, 0x36, 0x00]))).toBe("image/bmp");
    expect(detectImageContentType(Buffer.from("icns\x00\x00\x10\x00"))).toBe("image/x-icns");
    expect(detectImageContentType(Buffer.from([0xff, 0x0a, 0x00]))).toBe("image/jxl");
    expect(
      detectImageContentType(
        Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypheic")]),
      ),
    ).toBe("image/heic");
  });

  it("detects the remaining signatures Next knows (tiff/jxl-box/pdf/jp2)", () => {
    expect(detectImageContentType(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]))).toBe("image/tiff");
    expect(
      detectImageContentType(
        Buffer.concat([
          Buffer.from([0x00, 0x00, 0x00, 0x0c]),
          Buffer.from("JXL "),
          Buffer.from([0x0d, 0x0a, 0x87, 0x0a]),
        ]),
      ),
    ).toBe("image/jxl");
    expect(detectImageContentType(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(
      detectImageContentType(
        Buffer.concat([
          Buffer.from([0x00, 0x00, 0x00, 0x0c]),
          Buffer.from("jP  "),
          Buffer.from([0x0d, 0x0a, 0x87, 0x0a]),
        ]),
      ),
    ).toBe("image/jp2");
  });

  it("treats a 0x00 in an EXACT signature as a real byte, not a wildcard", () => {
    // Next only wildcards the length fields of WEBP/AVIF/HEIC (`!b || buffer[i] === b`);
    // every other signature is an exact compare. A blanket "0 means don't care" made
    // ICO's `00 00 01 00` a two-byte test, so unrelated bytes misdetected as ICO — and
    // the wrong sniff decides passthrough-vs-reencode.
    expect(detectImageContentType(Buffer.from([0x2a, 0x2a, 0x01, 0x00, 0x01]))).toBeNull();
    // The TIFF signature ends in a real 0x00 too.
    expect(detectImageContentType(Buffer.from([0x49, 0x49, 0x2a, 0x2a]))).toBeNull();
  });

  it("returns null for unrecognized bytes so callers can fall back", () => {
    expect(detectImageContentType(Buffer.from("not an image"))).toBeNull();
    expect(detectImageContentType(Buffer.alloc(0))).toBeNull();
  });
});

describe("w/q validation (port of ImageOptimizerCache.validateParams, isDev: false)", () => {
  const DEFAULTS = {
    deviceSizes: DEFAULT_IMAGE_DEVICE_SIZES,
    imageSizes: DEFAULT_IMAGE_SIZES,
    qualities: DEFAULT_IMAGE_QUALITIES,
  };
  const check = (query: string, config = DEFAULTS) =>
    validateImageSizeAndQuality(new URLSearchParams(query), config);

  it("mirrors Next's DEFAULTS exactly (imageSizes starts at 32, qualities is [75])", () => {
    // The measured divergences: the adapter's default imageSizes began at 16 and it had no
    // qualities set at all, so `w=16` and `q=50` returned 200 where `next start` 400s.
    expect(DEFAULT_IMAGE_SIZES).toEqual([32, 48, 64, 96, 128, 256, 384]);
    expect(DEFAULT_IMAGE_DEVICE_SIZES).toEqual([640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
    expect(DEFAULT_IMAGE_QUALITIES).toEqual([75]);
    expect(check("w=16&q=75")).toEqual({
      errorMessage: '"w" parameter (width) of 16 is not allowed',
    });
    expect(check("w=384&q=50")).toEqual({
      errorMessage: '"q" parameter (quality) of 50 is not allowed',
    });
  });

  it("accepts any (w, q) in the configured sets", () => {
    expect(check("w=32&q=75")).toEqual({ width: 32, quality: 75 });
    expect(check("w=3840&q=75")).toEqual({ width: 3840, quality: 75 });
    expect(check("w=16&q=40", { deviceSizes: [], imageSizes: [16], qualities: [40] })).toEqual({
      width: 16,
      quality: 40,
    });
  });

  // Bodies below are byte-for-byte what `next start` 16.2.10 answered on a copy of Next's
  // test/e2e/image-optimizer fixture (2026-07-25).
  it.each([
    ["", '"w" parameter (width) is required'],
    ["q=75", '"w" parameter (width) is required'],
    ["w=&q=75", '"w" parameter (width) is required'],
    ["w=384&w=32&q=75", '"w" parameter (width) cannot be an array'],
    // Repeated-but-first-empty: upstream tests `!w` on the PARSED value, which is a
    // non-empty ARRAY here and therefore truthy, so this is "cannot be an array" — not
    // "is required".
    ["w=&w=384&q=75", '"w" parameter (width) cannot be an array'],
    ["w=384&q=&q=75", '"q" parameter (quality) cannot be an array'],
    ["w=abc&q=75", '"w" parameter (width) must be an integer greater than 0'],
    ["w=384.5&q=75", '"w" parameter (width) must be an integer greater than 0'],
    ["w=-5&q=75", '"w" parameter (width) must be an integer greater than 0'],
    ["w=+384&q=75", '"w" parameter (width) must be an integer greater than 0'],
    ["w=384", '"q" parameter (quality) is required'],
    ["w=384&q=", '"q" parameter (quality) is required'],
    ["w=384&q=75&q=50", '"q" parameter (quality) cannot be an array'],
    ["w=384&q=abc", '"q" parameter (quality) must be an integer between 1 and 100'],
    ["w=384&q=0", '"q" parameter (quality) must be an integer between 1 and 100'],
    ["w=384&q=101", '"q" parameter (quality) must be an integer between 1 and 100'],
    ["w=999999&q=75", '"w" parameter (width) of 999999 is not allowed'],
  ])("rejects ?%s with next start's exact message", (query, errorMessage) => {
    expect(check(query)).toEqual({ errorMessage });
  });

  it("checks `w` shape BEFORE `q` presence (the order decides which body a client sees)", () => {
    // Both params are wrong; upstream reports the `w` one because it validates w first.
    expect(check("w=abc")).toEqual({
      errorMessage: '"w" parameter (width) must be an integer greater than 0',
    });
    // But the `^[0-9]+$` shape check on BOTH runs before the numeric range on either, so a
    // bad `q` shape wins over an out-of-set `w`.
    expect(check("w=17&q=abc")).toEqual({
      errorMessage: '"q" parameter (quality) must be an integer between 1 and 100',
    });
  });

  it("interpolates the RAW q string in the not-allowed message, as upstream does", () => {
    expect(check("w=384&q=050")).toEqual({
      errorMessage: '"q" parameter (quality) of 050 is not allowed',
    });
  });

  it("rejects EVERY width when the allowed set is empty (never 'allow anything')", () => {
    // `imageSizes: []` is valid config. The old gate skipped the membership check entirely
    // when the union came out empty, which handed an unbounded `w` straight to sharp.
    const empty = { deviceSizes: [], imageSizes: [], qualities: [75] };
    expect(check("w=384&q=75", empty)).toEqual({
      errorMessage: '"w" parameter (width) of 384 is not allowed',
    });
    expect(check("w=999999&q=75", empty)).toEqual({
      errorMessage: '"w" parameter (width) of 999999 is not allowed',
    });
  });

  it("skips the qualities check only when qualities is undefined (upstream's `if (qualities)`)", () => {
    const noQualities = {
      deviceSizes: DEFAULT_IMAGE_DEVICE_SIZES,
      imageSizes: DEFAULT_IMAGE_SIZES,
      qualities: undefined,
    };
    expect(check("w=384&q=50", noQualities)).toEqual({ width: 384, quality: 50 });
    // The 1..100 range still applies without a configured set.
    expect(check("w=384&q=0", noQualities)).toEqual({
      errorMessage: '"q" parameter (quality) must be an integer between 1 and 100',
    });
  });
});
