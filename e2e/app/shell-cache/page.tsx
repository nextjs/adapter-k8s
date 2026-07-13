import { Suspense } from "react";
import { connection } from "next/server";
import { cacheTag } from "next/cache";

// `use cache` fragment baked into the STATIC PPR shell, tagged "shell". Its value is prerendered
// into the shell — the exact case that needs cross-replica revalidation via the shared incremental
// cache. Shows the generating time + which pod rendered it.
async function ShellFragment() {
  "use cache";
  cacheTag("shell");
  return (
    <p data-testid="shell-cache">
      shell-cached-at:{new Date().toISOString()} pod:{process.env.HOSTNAME ?? "?"}
    </p>
  );
}

// Dynamic hole — streamed resume, never cached.
async function LiveHole() {
  await connection();
  return <p data-testid="hole">live:{new Date().toISOString()}</p>;
}

export default function ShellCache() {
  return (
    <main>
      <h1 data-testid="shell-cache-page">Shell Cache (PPR)</h1>
      <ShellFragment />
      <Suspense fallback={<p>loading…</p>}>
        <LiveHole />
      </Suspense>
    </main>
  );
}
