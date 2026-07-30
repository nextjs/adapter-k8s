// MINIMAL REPRO for the emulateNextServer minimal-mode bug (pool-server/index.ts).
//
// `emulateNextServer` picks minimal vs non-minimal mode and has two domains: PPR routes, and
// plain SSG templates. Every other route in this fixture is PPR (`cacheComponents: true`), so
// the second domain had no coverage — and it is broken in production: with Valkey configured
// those routes run MINIMAL, re-render on every request, and never report a cache hit.
//
// Getting a route of the right shape into THIS fixture needs care:
//   - no `export const revalidate` / `dynamic` — cacheComponents makes Next reject both
//     outright ("Route segment config is not compatible with nextConfig.cacheComponents").
//   - no dynamic IO (no Date.now(), no Math.random(), no headers()/cookies()) — any of those
//     make the route postpone, which makes it PPR-capable, which routes it to the OTHER rung.
//
// So: fully static body, params only. That is `prerender && !ppr` + APP_PAGE + a template
// owning a build-time prerender — exactly the `emulatedSsgTemplates` case.
//
// The live guard requests a slug that is NOT in generateStaticParams, so it has no build
// artifact and must be generated on demand and then served from the shared incremental cache.
// Because the body is static, the guard asserts the CACHE HEADER rather than content drift —
// the same thing upstream's app-static asserts (`expect(pageCache).not.toBe('MISS')`).
export function generateStaticParams() {
  return [{ slug: "prebuilt" }];
}

export default async function IsrTemplate({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main>
      <h1 data-testid="isr-template">isr-template</h1>
      <span data-testid="isr-slug">{slug}</span>
    </main>
  );
}
