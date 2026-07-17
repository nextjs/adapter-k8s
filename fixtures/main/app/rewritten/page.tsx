// Target of the middleware rewrite from /from-mw. If a request to /from-mw renders
// this content, middleware executed (in front of the CDN) and rewrote the request.
export default function Rewritten() {
  return (
    <main>
      <h1 data-testid="rewritten">Rewritten by middleware</h1>
      <p>You requested a path that middleware rewrote to /rewritten.</p>
    </main>
  );
}
