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
