// Force-dynamic SSR page — must NOT be cached; renders a fresh timestamp per request.
export const dynamic = "force-dynamic";

export default function Ssr() {
  return (
    <main>
      <h1 data-testid="ssr">SSR</h1>
      <p>
        Rendered at <span data-testid="ssr-time">{new Date().toISOString()}</span>
      </p>
    </main>
  );
}
