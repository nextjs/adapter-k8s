export function resizeForRequestedWidth<
  T extends {
    resize: (
      width: number | undefined,
      height: undefined,
      options: { withoutEnlargement: true },
    ) => T;
  },
>(pipeline: T, width: number | undefined): T {
  // Next's optimizer never enlarges a smaller source merely because the selected srcset candidate
  // is wider. Apart from wasting bytes, upscaling changes the intrinsic dimensions reported to
  // legacy Image onLoadingComplete callbacks (400x400 incorrectly became 640x640).
  return pipeline.resize(width, undefined, { withoutEnlargement: true });
}

export type ImageEncode = "avif" | "webp" | "png" | "jpeg" | "passthrough";

// Magic-byte sniffer mirroring Next's `detectContentType` (next/src/server/image-optimizer.ts).
// Next derives the SOURCE format from the bytes, not from the URL or the upstream
// Content-Type header — an extensionless API route serving a PNG must be treated as
// PNG (deriving it from the URL made `/_next/image?url=/api/tiny-png` re-encode a
// PNG source to JPEG, breaking `next start` parity), and the dangerouslyAllowSVG
// gate must fire on actual SVG bytes even when the URL/header claims otherwise.
// Returns null when no signature matches; callers fall back to the upstream header /
// extension guess, matching Next's `detectContentType(buffer) || upstreamType`.
export function detectImageContentType(buffer: Buffer): string | null {
  const matches = (signature: number[], offset = 0): boolean =>
    // A 0 in the signature is a wildcard byte (Next uses the same convention for
    // WEBP/AVIF, whose signatures have don't-care length fields).
    signature.every((b, i) => b === 0 || buffer[offset + i] === b);
  if (matches([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (matches([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (matches([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))
    return "image/webp";
  // "<?xml" or "<svg" — both are how SVG documents begin (Next checks exactly these).
  if (matches([0x3c, 0x3f, 0x78, 0x6d, 0x6c])) return "image/svg+xml";
  if (matches([0x3c, 0x73, 0x76, 0x67])) return "image/svg+xml";
  if (matches([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))
    return "image/avif";
  if (matches([0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  return null;
}

// Decide the optimizer's output format the way Next's optimizer does: vector/animated
// sources Sharp shouldn't re-encode pass through untouched FIRST, then prefer
// AVIF/WebP when the client accepts them, otherwise PRESERVE the source format (a PNG
// stays PNG — do not force JPEG). Because the chosen bytes depend on Accept, the
// response MUST carry `Vary: Accept` or a shared cache serves the first visitor's
// variant to everyone.
export function negotiateImageFormat(
  acceptHeader: string,
  sourceContentType: string,
): { encode: ImageEncode; contentType: string } {
  // Next checks SVG + animated sources BEFORE Accept negotiation — letting Accept win
  // re-encoded animated GIFs to a static first frame and rasterized SVGs for any
  // browser sending `image/avif,image/webp`. Without an animation sniffer here, ALL
  // GIFs pass through: Next would re-encode a provably-static GIF, but serving the
  // source bytes unchanged is the harmless direction while re-encoding an animated
  // one destroys it. (SVG additionally goes through the dangerouslyAllowSVG gate in
  // index.ts before this is ever consulted.)
  if (sourceContentType.includes("gif") || sourceContentType.includes("svg")) {
    return { encode: "passthrough", contentType: sourceContentType };
  }
  if (acceptHeader.includes("image/avif")) {
    return { encode: "avif", contentType: "image/avif" };
  }
  if (acceptHeader.includes("image/webp")) {
    return { encode: "webp", contentType: "image/webp" };
  }
  if (sourceContentType.includes("png")) {
    return { encode: "png", contentType: "image/png" };
  }
  return { encode: "jpeg", contentType: "image/jpeg" };
}
