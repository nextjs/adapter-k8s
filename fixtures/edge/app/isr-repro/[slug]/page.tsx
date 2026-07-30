// MINIMAL REPRO, ours, for the emulateNextServer minimal-mode bug.
//
// Shape copied deliberately from upstream test/e2e/app-dir/app-static
// app/force-static/[slug]/page.js — the test that flipped when the failed fix was applied:
//   export const dynamic = 'force-static'
//   generateStaticParams -> ['first','second']
//   renders Date.now(); the test fetches a NON-prerendered slug twice and expects it unchanged.
//
// Why this file lives in fixtures/edge and not fixtures/main: `cacheComponents: true` makes
// EVERY app route PPR-capable, which routes it to the PPR rung in dispatch.ts — the rung that
// already handles `incrementalCacheShared` correctly. Measured: an equivalent route added to
// fixtures/main landed in `pprCapableRoutes` (2 of 2 routes) and cached correctly on GKE
// (MISS then HIT), i.e. it did not reproduce. Next also REJECTS `export const dynamic` under
// cacheComponents outright. fixtures/edge has no cacheComponents and no middleware, matching
// upstream app-static's conditions exactly.
//
// Expected behaviour, fetching /isr-repro/not-prebuilt twice:
//   correct — same #now on both responses (generated once, served from the shared cache)
//   today   — different #now each time; the pool runs minimal mode, re-renders per request,
//             and emits no x-nextjs-cache at all
export const dynamic = "force-static";

export function generateStaticParams() {
  return [{ slug: "prebuilt" }];
}

export default async function IsrRepro({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main>
      <p id="slug">{slug}</p>
      {/* Varies per RENDER. Identical across two responses ⟺ the second came from cache. */}
      <p id="now">{Date.now()}</p>
    </main>
  );
}
