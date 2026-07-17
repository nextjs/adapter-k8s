// Static (prerendered) home page — cacheable at the CDN edge.
export default function Home() {
  return (
    <main>
      <h1 data-testid="home">adapter-k8s e2e — Cache Components</h1>
      <p>Static home page (prerendered).</p>
      <ul>
        <li>
          <a href="/ssr">/ssr — PPR (static shell + streamed dynamic)</a>
        </li>
        <li>
          <a href="/isr">/isr — use cache (revalidatable, tag=isr)</a>
        </li>
        <li>
          <a href="/api/catalog">/api/catalog — cross-replica cached (shows serving pod)</a>
        </li>
        <li>
          <a href="/api/hello">/api/hello — dynamic route handler</a>
        </li>
      </ul>
    </main>
  );
}
