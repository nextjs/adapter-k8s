// MINIMAL REPRO (ours): a STATIC prerendered page with a per-render marker.
//
// The broken shape is precisely this — a static page whose handler pathname IS the matched
// pathname. dispatch.ts's `serveConcretePrerenderSeed` requires `handlerPathname !== mp`, so
// the build seed is only ever served for CONCRETE instances under a DYNAMIC template
// (/isr-repro/prebuilt). A static page falls through to handler invocation, which in
// production runs MINIMAL mode — and in minimal mode Next neither consults nor populates its
// incremental cache for the response (the platform is supposed to own it), while the adapter
// rewrites cache-control to `max-age=0, must-revalidate` so Cloud CDN cannot own it either.
// Result: re-render on every request, x-vercel-cache: MISS forever.
//
// The gate's own comment says the production side is covered because "Valkey owns the same
// lifecycle" — it does not, because minimal mode never reads it for page responses.
//
// No cacheComponents in this fixture, so Date.now() does NOT make the route dynamic — the
// build bakes a value (SSG), and any DIFFERENT value observed at runtime is a re-render.
//
// Expected (correct): repeat GETs return the SAME #now.
// Today (broken):     every GET returns a fresh #now, header stuck on MISS.
export default function IsrStatic() {
  return (
    <main>
      <p id="page">/isr-static</p>
      <p id="now">{Date.now()}</p>
    </main>
  );
}
