// Shell-less PPR probe (spec rev-4 "Option D" — docs/superpowers/specs/
// 2026-07-26-ppr-resume-shell-less-templates.md). Mirrors the structure of upstream's
// cache-components-allow-otel-spans `[slug]/early-span`: a PARTIALLY_STATIC dynamic template
// whose non-prerendered params render async work with NO Suspense boundary above it, so the
// build's static shell is empty and demoted (`fallback: null`) while the template lands in
// `pprCapableRoutes` with `rootParams: []`. Before Option D the pool answered these with a
// ~1.3KB closed empty Suspense boundary in ~20ms; a correct serve carries the resolved
// content after ~1s. The live suite asserts the resolved marker below.
import { Suspense } from "react";

async function asyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return 42;
}

export function generateStaticParams() {
  return [{ slug: "prerendered" }];
}

async function Work({ slug }: { slug: string }) {
  const result = await asyncWork();
  return (
    <p id="novel-result" className="result">
      resolved:{slug}:{result}
    </p>
  );
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug === "prerendered") {
    return null;
  }
  // Suspense with NO fallback content: the prerendered shell is just an empty closed
  // boundary (`<!--$--><!--/$-->`), which the build treats as an empty static shell and
  // demotes to `fallback: null` — the shell-less class. (Without ANY boundary, stable
  // Next 16.2.10 hard-errors the uncached IO at request time — NEXT_STATIC_GEN_BAILOUT —
  // instead of postponing; the boundary is what makes the render postpone.)
  return (
    <Suspense>
      <section id="novel">
        <h2>Shell-less PPR template (Option D probe)</h2>
        <Work slug={slug} />
      </section>
    </Suspense>
  );
}
