export function resizeForRequestedWidth<
  T extends {
    resize: (
      width: number | undefined,
      height: undefined,
      options: { withoutEnlargement: true },
    ) => T;
  },
>(
  pipeline: T,
  width: number | undefined,
): T {
  // Next's optimizer never enlarges a smaller source merely because the selected srcset candidate
  // is wider. Apart from wasting bytes, upscaling changes the intrinsic dimensions reported to
  // legacy Image onLoadingComplete callbacks (400x400 incorrectly became 640x640).
  return pipeline.resize(width, undefined, { withoutEnlargement: true });
}
