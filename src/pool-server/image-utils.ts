import { createHash } from "node:crypto";

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

export type ImageEncode = "avif" | "webp" | "png" | "jpeg" | "gif" | "tiff" | "passthrough";

// Next's FIRST gate in imageOptimizer: a source whose type is missing, is not an
// `image/*` type, or carries a comma is not an image at all — 400 up front, never
// handed to sharp. Without it a text/html or application/pdf source rode all the way
// into sharp and came back as a 502 ("Failed to process image") where `next start`
// answers `400 The requested resource isn't a valid image.` (verified 2026-07-24).
// Parameters are stripped first so `image/png; charset=binary` still qualifies.
export function isOptimizableImageContentType(contentType: string): boolean {
  const baseType = contentType.split(";")[0]!.trim().toLowerCase();
  return baseType.startsWith("image/") && !baseType.includes(",");
}

// Magic-byte sniffer mirroring Next's `detectContentType` (next/src/server/image-optimizer.ts).
// Next derives the SOURCE format from the bytes, not from the URL or the upstream
// Content-Type header — an extensionless API route serving a PNG must be treated as
// PNG (deriving it from the URL made `/_next/image?url=/api/tiny-png` re-encode a
// PNG source to JPEG, breaking `next start` parity), and the dangerouslyAllowSVG
// gate must fire on actual SVG bytes even when the URL/header claims otherwise.
// Returns null when no signature matches; callers fall back to the upstream header /
// extension guess, matching Next's `detectContentType(buffer) || upstreamType`.
//
// The signature list must stay COMPLETE, not just cover the web-native formats: the
// sniffed type is what selects passthrough-vs-reencode below, and a format sharp
// cannot decode (ICO, BMP) that sniffs as `null` falls through to the extension guess
// and then into sharp, which throws → 502. `next start` serves those untouched
// (BYPASS_TYPES). `/test.ico` and `/test.bmp` 502'd exactly this way.
// `null` in a signature is a don't-care byte — Next writes those as `!b || ...`
// (only WEBP/AVIF/HEIC have them, whose leading bytes are length fields). Every
// other signature is an exact match in Next, so a 0x00 in it must NOT be treated as
// a wildcard (a blanket wildcard made ICO's `00 00 01 00` match on two bytes).
export function detectImageContentType(buffer: Buffer): string | null {
  const matches = (signature: (number | null)[]): boolean =>
    signature.every((b, i) => b === null || buffer[i] === b);
  // Order mirrors Next's exactly: the JXL box and JP2 signatures share a prefix, and
  // the wildcard-prefixed ftyp brands (AVIF/HEIC) must not shadow ICO.
  if (matches([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (matches([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (matches([0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]))
    return "image/webp";
  // "<?xml" or "<svg" — both are how SVG documents begin (Next checks exactly these).
  if (matches([0x3c, 0x3f, 0x78, 0x6d, 0x6c])) return "image/svg+xml";
  if (matches([0x3c, 0x73, 0x76, 0x67])) return "image/svg+xml";
  if (matches([null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))
    return "image/avif";
  if (matches([0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (matches([0x69, 0x63, 0x6e, 0x73])) return "image/x-icns";
  if (matches([0x49, 0x49, 0x2a, 0x00])) return "image/tiff";
  if (matches([0x42, 0x4d])) return "image/bmp";
  if (matches([0xff, 0x0a])) return "image/jxl";
  if (matches([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]))
    return "image/jxl";
  if (matches([null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))
    return "image/heic";
  if (matches([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (matches([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]))
    return "image/jp2";
  return null;
}

// Next's BYPASS_TYPES: source formats the optimizer refuses to re-encode and returns
// verbatim (next/src/server/image-optimizer.ts). Sharp/libvips cannot even DECODE ICO
// or BMP ("Input buffer contains unsupported image format"), so re-encoding them is not
// a quality trade-off — it is a hard 502 on a request `next start` answers 200 with the
// source bytes (verified against `next start` on the next-image-legacy/default fixture,
// 2026-07-24: `/_next/image?url=/test.ico` → 200 image/x-icon, byte-identical to
// public/test.ico; same for /test.bmp → 200 image/bmp).
const BYPASS_CONTENT_TYPES = new Set([
  "image/svg+xml",
  "image/x-icon",
  "image/x-icns",
  "image/bmp",
  "image/jxl",
  "image/heic",
]);

// Next's ANIMATABLE_TYPES: the only source formats it even asks `isAnimated` about
// (next/src/server/image-optimizer.ts). Anything else cannot carry frames, so the
// sniffer below is never consulted for it.
const ANIMATABLE_CONTENT_TYPES = new Set(["image/webp", "image/png", "image/gif"]);

// Next's default `images.formats` (next/src/shared/lib/image-config.ts imageConfigDefault).
// NOT ['image/avif','image/webp'] — a stock app must serve WebP even to a browser that
// advertises AVIF, and AVIF encoding is several times slower per request.
export const DEFAULT_IMAGE_FORMATS = ["image/webp"] as const;

// --- `w` / `q` validation (ImageOptimizerCache.validateParams) -------------------
//
// A faithful port of Next's own gate, and NOT merely cosmetic parity: every distinct
// accepted (w, q) pair is a separate CDN cache entry AND a separate sharp encode, so an
// unenforced set is a cache-fill / CPU-amplification vector that a single client can drive
// with `?w=17&q=1..100`. Measured against `next start` on test/e2e/image-optimizer's
// fixture (2026-07-25): `?url=/test.png&w=16&q=75` → 400 `"w" parameter (width) of 16 is
// not allowed`, `&w=384&q=50` → 400 `"q" parameter (quality) of 50 is not allowed`, where
// the adapter answered 200 for both.
//
// Next's defaults, taken from `imageConfigDefault` (next/src/shared/lib/image-config.ts).
// `imageSizes` starts at 32, NOT 16 — the adapter's old default admitted a `w=16` that
// `next start` rejects. `qualities` defaults to a single value: exactly one quality per
// source is cacheable/encodable unless the app opts into more.
export const DEFAULT_IMAGE_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const DEFAULT_IMAGE_SIZES = [32, 48, 64, 96, 128, 256, 384];
export const DEFAULT_IMAGE_QUALITIES = [75];

export interface ImageSizeQualityConfig {
  deviceSizes: readonly number[];
  imageSizes: readonly number[];
  // `undefined` means "no qualities configured", which upstream treats as "any 1..100".
  // Next's resolved config always carries [75], so this is only reachable when the
  // adapter cannot read the build config at all.
  qualities?: readonly number[] | undefined;
}

/**
 * Next's `ImageOptimizerCache.validateParams` for the `w`/`q` half, production mode
 * (`isDev: false`, so no BLUR_IMG_SIZE / BLUR_QUALITY escape hatches). Returns the exact
 * `errorMessage` Next sends as the 400 body, or the parsed pair.
 *
 * The checks and their ORDER are upstream's verbatim, because the message a client sees
 * depends on it: presence, then array-ness, then the `^[0-9]+$` shape (so `w=384.5` and
 * `w=-5` are "must be an integer greater than 0", not "not allowed"), for `w` and then
 * `q`, and only afterwards the numeric range and the allowed-set membership.
 *
 * `w`/`q` repeated in the query is upstream's "cannot be an array" case: Next parses the
 * query with `parseUrl`, which collapses repeats into an array, so `?w=384&w=32` is a 400
 * rather than a first-wins 200.
 */
export function validateImageSizeAndQuality(
  params: URLSearchParams,
  config: ImageSizeQualityConfig,
): { errorMessage: string } | { width: number; quality: number } {
  const w = params.get("w");
  const q = params.get("q");

  // Array-ness is tested BEFORE presence even though upstream writes `!w` first: what
  // upstream is testing there is the whole PARSED value, which for a repeated param is a
  // non-empty array and therefore always truthy. `?w=&w=384` is "cannot be an array"
  // upstream, not "is required" — checking `get("w")` (the first value, "") first would
  // have inverted that.
  if (params.getAll("w").length > 1) {
    return { errorMessage: '"w" parameter (width) cannot be an array' };
  }
  if (!w) return { errorMessage: '"w" parameter (width) is required' };
  if (!/^[0-9]+$/.test(w)) {
    return { errorMessage: '"w" parameter (width) must be an integer greater than 0' };
  }
  if (params.getAll("q").length > 1) {
    return { errorMessage: '"q" parameter (quality) cannot be an array' };
  }
  if (!q) return { errorMessage: '"q" parameter (quality) is required' };
  if (!/^[0-9]+$/.test(q)) {
    return { errorMessage: '"q" parameter (quality) must be an integer between 1 and 100' };
  }

  const width = parseInt(w, 10);
  if (width <= 0 || Number.isNaN(width)) {
    return { errorMessage: '"w" parameter (width) must be an integer greater than 0' };
  }

  // Upstream: `[...deviceSizes, ...imageSizes].includes(width)`. Membership is
  // UNCONDITIONAL — an empty allowed set rejects every width (`imageSizes: []` is valid
  // config). Treating an empty set as "allow anything", as this previously did, is the
  // one direction that must never happen: it hands an unbounded `w` to sharp.
  const sizes = [...config.deviceSizes, ...config.imageSizes];
  if (!sizes.includes(width)) {
    return { errorMessage: `"w" parameter (width) of ${width} is not allowed` };
  }

  const quality = parseInt(q, 10);
  if (Number.isNaN(quality) || quality < 1 || quality > 100) {
    return { errorMessage: '"q" parameter (quality) must be an integer between 1 and 100' };
  }
  if (config.qualities && !config.qualities.includes(quality)) {
    // Upstream interpolates the RAW string here, not the parsed int — `q=075` reports
    // `of 075`. Mirrored so the body matches byte-for-byte.
    return { errorMessage: `"q" parameter (quality) of ${q} is not allowed` };
  }

  return { width, quality };
}

// Animation sniffing, ported byte-for-byte from `is-animated`
// (next/dist/compiled/is-animated), which is what Next's optimizer calls. Parity here is
// by construction rather than by approximation: the classification decides whether a
// source is re-encoded (destroying an animation) or served verbatim, so a HAND-ROLLED
// heuristic would be exactly the wrong thing to ship. The differential test in
// tests/pool-server/image-utils.test.ts pins the agreement.
//
// Bounds: every read is a plain index (undefined ⇒ falsy ⇒ loop ends), except the APNG
// chunk-length read, which is explicitly range-checked — upstream would throw
// ERR_OUT_OF_RANGE on a truncated file. A parse that cannot complete answers "not proven
// animated", which routes the bytes to sharp; sharp then validates them and fails closed
// on garbage, rather than the optimizer serving unvalidated bytes back.
function gifDataBlocksLength(buffer: Buffer, offset: number): number {
  let length = 0;
  while (buffer[offset + length]) length += buffer[offset + length]! + 1;
  return length + 1;
}

function isAnimatedGif(buffer: Buffer): boolean {
  if (buffer.subarray(0, 3).toString("ascii") !== "GIF") return false;
  let hasColorTable = buffer[10]! & 0x80;
  let colorTableSize = buffer[10]! & 0x07;
  let imagesCount = 0;
  // Header (6) + logical screen descriptor (7) + global color table.
  let offset = 6 + 7 + (hasColorTable ? 3 * Math.pow(2, colorTableSize + 1) : 0);
  while (imagesCount < 2 && offset < buffer.length) {
    switch (buffer[offset]) {
      case 0x2c: // image descriptor — one frame
        imagesCount += 1;
        hasColorTable = buffer[offset + 9]! & 0x80;
        colorTableSize = buffer[offset + 9]! & 0x07;
        offset += 10;
        offset += hasColorTable ? 3 * Math.pow(2, colorTableSize + 1) : 0;
        offset += gifDataBlocksLength(buffer, offset + 1) + 1;
        break;
      case 0x21: // extension block
        offset += 2;
        offset += gifDataBlocksLength(buffer, offset);
        break;
      default: // trailer (0x3b) or anything unexpected — stop scanning
        offset = buffer.length;
        break;
    }
  }
  return imagesCount > 1;
}

function isAnimatedPng(buffer: Buffer): boolean {
  let hasACTL = false;
  let hasIDAT = false;
  let hasFDAT = false;
  let previousChunkType: string | null = null;
  let offset = 8;
  while (offset < buffer.length) {
    // Chunk header is 8 bytes (length + type); a truncated tail is not an APNG.
    if (offset + 8 > buffer.length) return false;
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    switch (chunkType) {
      case "acTL":
        hasACTL = true;
        break;
      case "IDAT":
        if (!hasACTL) return false;
        if (previousChunkType !== "fcTL" && previousChunkType !== "IDAT") return false;
        hasIDAT = true;
        break;
      case "fdAT":
        if (!hasIDAT) return false;
        if (previousChunkType !== "fcTL" && previousChunkType !== "fdAT") return false;
        hasFDAT = true;
        break;
    }
    previousChunkType = chunkType;
    offset += 4 + 4 + chunkLength + 4;
  }
  return hasACTL && hasIDAT && hasFDAT;
}

function isAnimatedWebp(buffer: Buffer): boolean {
  // Upstream scans the whole buffer for the literal "ANIM" chunk id rather than walking
  // the RIFF structure. Kept as-is: a stricter walk could disagree on a real file.
  const signature = [0x41, 0x4e, 0x49, 0x4d]; // "ANIM"
  for (let i = 0; i < buffer.length; i++) {
    let matched = 0;
    while (matched < signature.length && buffer[i + matched] === signature[matched]) matched++;
    if (matched === signature.length) return true;
  }
  return false;
}

// True when the bytes are a multi-frame GIF / APNG / animated WebP. Only these three
// formats can be animated (Next's ANIMATABLE_TYPES); everything else answers false.
export function isAnimatedImage(buffer: Buffer): boolean {
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return isAnimatedGif(buffer);
  if (buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return isAnimatedPng(buffer);
  // RIFF....WEBP
  if (buffer.subarray(8, 12).toString("ascii") === "WEBP") return isAnimatedWebp(buffer);
  return false;
}

// --- Accept negotiation within images.formats -----------------------------------
//
// Next picks the output mime type with `getSupportedMimeType(images.formats, accept)` =
// `@hapi/accept`'s `mediaType(accept, formats)` followed by a raw
// `accept.includes(result)` guard. Both halves matter and neither is "first format the
// header mentions":
//   • hapi orders the CLIENT's entries (q desc, then wildcards last / alphabetical) and
//     returns the best-ranked one that matches a configured format — so with
//     `formats: ['image/avif','image/webp']` a client listing both at equal q gets AVIF
//     because of the client's ordering rules, not the config's.
//   • when the best-ranked entry is a WILDCARD, hapi answers with a configured format
//     that is deliberately absent from the header, so the `includes` guard always
//     rejects it. That is why `Accept: */*` yields NO negotiated format and Next falls
//     back to preserving the source type (verified against `next start`:
//     `?url=/test.png` with `*/*` ⇒ image/png, with `image/webp` ⇒ image/webp).
// The port below reproduces both halves; its agreement with the real @hapi/accept is
// fuzz-verified in tests/pool-server/image-utils.test.ts.
//
// ONE deliberate divergence: hapi appends the client's non-`q` media PARAMETERS to the
// token it returns (`Accept: image/webp;level=1` ⇒ `"image/webp;level=1"`), which Next
// then uses verbatim as the response Content-Type. That is an upstream artifact, and
// mirroring it would let a request paint an arbitrary parameter into a response header.
// Parameters are dropped here; the negotiated value is always a bare media type.
interface AcceptEntry {
  token: string;
  type: string;
  subtype: string;
  q: number;
  params: number;
  pos: number;
}

// hapi's validMediaRx — an entry that is not `*/*`, `type/*` or `type/subtype` is skipped.
const VALID_MEDIA_TYPE =
  /^(?:\*\/\*)|(?:[\w!#$%&'*+\-.^`|~]+\/\*)|(?:[\w!#$%&'*+\-.^`|~]+\/[\w!#$%&'*+\-.^`|~]+)$/;

function parseAcceptHeader(acceptHeader: string): AcceptEntry[] {
  // hapi strips ALL spaces/tabs first, so `image/webp; q=0.5` parses like `image/webp;q=0.5`.
  const header = acceptHeader.replace(/[ \t]/g, "");
  const entries: AcceptEntry[] = [];
  header.split(",").forEach((part, pos) => {
    if (!part) return;
    const segments = part.split(";");
    const token = segments[0]!.toLowerCase();
    if (!VALID_MEDIA_TYPE.test(token)) return;
    let q = 1;
    let params = 0;
    for (const segment of segments.slice(1)) {
      const eq = segment.indexOf("=");
      const name = eq === -1 ? segment : segment.slice(0, eq);
      const value = eq === -1 ? "" : segment.slice(eq + 1);
      if (name === "q" || name === "Q") {
        const parsed = parseFloat(value);
        // hapi: out-of-range or unparseable q means 1; only an exact 0 removes the entry.
        q = !Number.isFinite(parsed) || parsed > 1 || (parsed < 0.001 && parsed !== 0) ? 1 : parsed;
      } else {
        params++;
      }
    }
    if (!q) return;
    const slash = token.indexOf("/");
    entries.push({
      token,
      type: token.slice(0, slash),
      subtype: token.slice(slash + 1),
      q,
      params,
      pos,
    });
  });
  // hapi's sort: q desc, then type then subtype with `*` LAST (not alphabetically first),
  // then more-parameterized first, then original position.
  const wildcardLast = (a: string, b: string): number => {
    if (a === b) return 0;
    if (a === "*") return 1;
    if (b === "*") return -1;
    return a < b ? -1 : 1;
  };
  return entries.sort(
    (a, b) =>
      b.q - a.q ||
      wildcardLast(a.type, b.type) ||
      wildcardLast(a.subtype, b.subtype) ||
      b.params - a.params ||
      a.pos - b.pos,
  );
}

/**
 * The output mime type Next would negotiate for `acceptHeader` given `formats`
 * (`images.formats`), or null when it would negotiate none — in which case the caller
 * preserves the source format. Mirrors `getSupportedMimeType` + the `accept.includes`
 * guard; see the block comment above.
 */
export function negotiateImageMimeType(
  acceptHeader: string,
  formats: readonly string[],
): string | null {
  if (!formats.length) return null;
  const wanted = formats.map((format) => format.toLowerCase());
  const entries = parseAcceptHeader(acceptHeader);
  // Tokens the header mentions AT ALL (including `q=0` ones): hapi excludes these from
  // wildcard expansion, and that exclusion is what makes the `includes` guard fail.
  const mentioned = new Set(
    acceptHeader
      .replace(/[ \t]/g, "")
      .split(",")
      .map((part) => part.split(";")[0]!.toLowerCase())
      .filter((token) => VALID_MEDIA_TYPE.test(token)),
  );
  for (const entry of entries) {
    if (entry.type === "*" || entry.subtype === "*") {
      // hapi answers this entry with the first configured format the header does NOT
      // mention; Next's `accept.includes()` then rejects it. If every matching format
      // IS mentioned, hapi contributes nothing for this entry and scanning continues.
      const expandable = wanted.some(
        (format) =>
          (entry.type === "*" || format.startsWith(`${entry.type}/`)) && !mentioned.has(format),
      );
      if (expandable) return null;
      continue;
    }
    if (wanted.includes(entry.token)) {
      // The guard is a raw substring test on the ORIGINAL header, so it is
      // case-SENSITIVE upstream: `Accept: IMAGE/WEBP` negotiates nothing. Mirrored.
      return acceptHeader.includes(entry.token) ? entry.token : null;
    }
  }
  return null;
}

// Decide the optimizer's output format the way Next's optimizer does: vector/animated
// sources Sharp shouldn't re-encode pass through untouched FIRST, then negotiate within
// the app's configured `images.formats`, otherwise PRESERVE the source format (a PNG
// stays PNG — do not force JPEG). Because the chosen bytes depend on Accept, the
// response MUST carry `Vary: Accept` or a shared cache serves the first visitor's
// variant to everyone.
export function negotiateImageFormat(
  acceptHeader: string,
  sourceContentType: string,
  options: { formats?: readonly string[]; sourceBytes?: Buffer } = {},
): { encode: ImageEncode; contentType: string } {
  const formats = options.formats ?? DEFAULT_IMAGE_FORMATS;
  // An upstream header can carry parameters (`image/bmp; charset=binary`) — compare on
  // the bare media type so a parameter can't smuggle a bypass type past this check.
  const baseType = sourceContentType.split(";")[0]!.trim().toLowerCase();
  // Next checks animated + bypass sources BEFORE Accept negotiation — letting Accept win
  // re-encoded animated GIFs to a static first frame, rasterized SVGs, and 502'd ICO/BMP
  // for any browser sending `image/avif,image/webp`. (SVG additionally goes through the
  // dangerouslyAllowSVG gate in index.ts before this is ever consulted.)
  //
  // Only a PROVEN animation bypasses the optimizer: `next start` re-encodes a static GIF
  // (2301 B source → 916 B webp on the upstream image-optimizer fixture), so blanket GIF
  // passthrough was a real byte-size divergence. Without `sourceBytes` the animation
  // question is unanswerable, so every animatable source passes through — the harmless
  // direction, since re-encoding an animated source destroys it.
  if (
    ANIMATABLE_CONTENT_TYPES.has(baseType) &&
    (!options.sourceBytes || isAnimatedImage(options.sourceBytes))
  ) {
    return { encode: "passthrough", contentType: sourceContentType };
  }
  if (BYPASS_CONTENT_TYPES.has(baseType)) {
    return { encode: "passthrough", contentType: sourceContentType };
  }
  const negotiated = negotiateImageMimeType(acceptHeader, formats);
  if (negotiated === "image/avif") return { encode: "avif", contentType: "image/avif" };
  if (negotiated === "image/webp") return { encode: "webp", contentType: "image/webp" };
  // No negotiated format (or one this pipeline cannot emit — Next only documents
  // avif/webp for images.formats). Next then keeps the source type whenever it has a
  // known extension and is not itself webp/avif, else falls back to JPEG.
  if (baseType === "image/png" || baseType === "image/apng") {
    return { encode: "png", contentType: "image/png" };
  }
  if (baseType === "image/gif") return { encode: "gif", contentType: "image/gif" };
  // TIFF is the one remaining source type Next PRESERVES here: `getExtension('image/tiff')`
  // is truthy and it is neither webp nor avif, so upstream's `contentType` stays image/tiff
  // and `optimizeImage`'s if-chain (avif/webp/png/jpeg only) sets NO encoder, leaving sharp
  // to write back the input format. Measured on the fixture's /test.tiff at w=384&q=75:
  // `next start` → 200 image/tiff 2962 B, adapter (default: jpeg) → 200 image/jpeg 1918 B.
  if (baseType === "image/tiff") return { encode: "tiff", contentType: "image/tiff" };
  return { encode: "jpeg", contentType: "image/jpeg" };
}

// --- Optimizer response headers (`next start` parity) ---------------------------

/**
 * Next's optimizer ETag: `base64url(sha256(bytes))`, unquoted (`getImageEtag` →
 * `getHash`). The shape is mirrored deliberately — parity is the arbiter, and Next has
 * shipped this unquoted form through CDNs for years.
 *
 * Next uses this hash only for RE-ENCODED bytes; for passthrough (animated/bypass/SVG)
 * responses it base64url-encodes the upstream weak ETag, which for a local file is
 * derived from size+mtime. The adapter hashes the bytes in every case on purpose: an
 * mtime-derived validator differs per replica (staged image layers re-stamp
 * timestamps), so it would make the same URL answer with a different ETag depending on
 * which pod served it — pointless revalidation churn behind a shared CDN.
 */
export function imageEtag(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("base64url");
}

/**
 * Next's optimizer Cache-Control (`setResponseHeaders`): content-addressed sources under
 * `/_next/static/**\/media` are immutable, everything else gets a positive freshness
 * lifetime plus `must-revalidate`.
 */
export function imageCacheControl(maxAge: number, isStatic: boolean): string {
  return isStatic
    ? "public, max-age=315360000, immutable"
    : `public, max-age=${maxAge}, must-revalidate`;
}

/**
 * `Math.max(images.minimumCacheTTL, getMaxAge(upstreamCacheControl))` — Next raises the
 * response's freshness to the upstream's own when the upstream asks for longer, and
 * ignores an upstream `no-store` entirely (only s-maxage/max-age are read).
 */
export function imageMaxAge(minimumCacheTTL: number, upstreamCacheControl?: string | null): number {
  return Math.max(minimumCacheTTL, upstreamMaxAge(upstreamCacheControl));
}

function upstreamMaxAge(cacheControl: string | null | undefined): number {
  if (!cacheControl) return 0;
  const match =
    /\bs-maxage=\s*"?(\d+)"?/i.exec(cacheControl) ?? /\bmax-age=\s*"?(\d+)"?/i.exec(cacheControl);
  if (!match) return 0;
  const value = parseInt(match[1]!, 10);
  // An UNTRUSTED upstream (an external image host) supplied this, and it lands in a
  // response header — take it only when it is a real non-negative integer.
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// `getExtension(contentType)` for every type the byte sniffer can report, so the
// Content-Disposition filename gets the same extension `next start` gives it (Next reads
// this from `send`'s mime table). Closed on purpose: an unknown type keeps the source
// filename untouched rather than growing a bogus extension.
const EXTENSION_BY_CONTENT_TYPE = new Map([
  ["image/avif", "avif"],
  ["image/apng", "apng"],
  ["image/bmp", "bmp"],
  ["image/gif", "gif"],
  ["image/heic", "heic"],
  ["image/jp2", "jp2"],
  ["image/jpeg", "jpeg"],
  ["image/jxl", "jxl"],
  ["image/png", "png"],
  ["image/svg+xml", "svg"],
  ["image/tiff", "tiff"],
  ["image/webp", "webp"],
  ["image/x-icns", "icns"],
  ["image/x-icon", "ico"],
]);

/**
 * Next's `getFileNameWithExtension`: the last path segment of the requested `url`
 * parameter, truncated at its first `.`, plus the extension of the OUTPUT content type
 * (a PNG source served as WebP downloads as `name.webp`).
 */
export function imageDownloadFileName(sourceUrl: string, contentType: string): string {
  const withoutQuery = sourceUrl.split("?", 1)[0]!;
  const segment = withoutQuery.split("/").pop() ?? "";
  if (!segment) return "image.bin";
  const stem = segment.split(".", 1)[0]!;
  const extension = EXTENSION_BY_CONTENT_TYPE.get(contentType.split(";")[0]!.trim().toLowerCase());
  return extension ? `${stem}.${extension}` : segment;
}

/**
 * `content-disposition`'s formatter (the module Next calls), ported so the header matches
 * `next start` byte-for-byte — including the RFC 5987 pair for a non-Latin-1 name:
 * `attachment; filename="äöü???í.webp"; filename*=UTF-8''%C3%A4….webp`.
 *
 * This is also the sanitizer for a request-controlled value reaching a response header:
 * the quoted form replaces every byte outside `\x20-\x7e` / `\xa0-\xff` with `?` (so CR,
 * LF and DEL can never appear) and escapes `"` and `\`, while the extended form is
 * percent-encoded. Header injection is impossible by construction, not by an upstream
 * 400 happening to fire first.
 */
export function imageContentDisposition(
  sourceUrl: string,
  contentType: string,
  type: "attachment" | "inline",
): string {
  const name = imageDownloadFileName(sourceUrl, contentType);
  const isLatin1Printable = /^[\x20-\x7e\x80-\xff]+$/.test(name);
  const fallback = name.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
  const hasFallback = fallback !== name;
  const parts: string[] = [type];
  if (isLatin1Printable || hasFallback) {
    const quoted = (hasFallback ? fallback : name).replace(/([\\"])/g, "\\$1");
    parts.push(`filename="${quoted}"`);
  }
  if (hasFallback || !isLatin1Printable || /%[0-9A-Fa-f]{2}/.test(name)) {
    // The escaped set is upstream's verbatim (`content-disposition`'s `ustring`): every
    // character RFC 5987 forbids unencoded, control characters included.
    const encoded = encodeURIComponent(name).replace(
      // oxlint-disable-next-line no-control-regex
      /[\u0000-\u0020"'()*,/:;<=>?@[\\\]{}\u007f]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    parts.push(`filename*=UTF-8''${encoded}`);
  }
  return parts.join("; ");
}
