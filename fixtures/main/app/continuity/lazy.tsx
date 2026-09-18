"use client";

export default function LazyPanel() {
  return (
    <p data-testid="continuity-lazy-version">
      {process.env.NEXT_PUBLIC_CONTINUITY_VERSION ?? "unversioned"}
    </p>
  );
}
