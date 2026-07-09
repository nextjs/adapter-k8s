// Static (prerendered) home page — cacheable at the CDN edge.
export default function Home() {
  return (
    <main>
      <h1 data-testid="home">adapter-k8s e2e</h1>
      <p>Static home page (prerendered).</p>
      <ul>
        <li><a href="/ssr">/ssr — dynamic</a></li>
        <li><a href="/isr">/isr — revalidate 60s</a></li>
        <li><a href="/from-mw">/from-mw — middleware rewrite → /rewritten</a></li>
        <li><a href="/api/hello">/api/hello — route handler</a></li>
      </ul>
    </main>
  );
}
