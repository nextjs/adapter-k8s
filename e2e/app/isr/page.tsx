// ISR page — prerendered, revalidates every 60s. Cacheable at the CDN edge with a
// bounded TTL; the timestamp reflects the last (re)generation, not the request time.
export const revalidate = 60;

export default function Isr() {
  return (
    <main>
      <h1 data-testid="isr">ISR</h1>
      <p>
        Generated at <span data-testid="isr-time">{new Date().toISOString()}</span> (revalidate 60s)
      </p>
    </main>
  );
}
