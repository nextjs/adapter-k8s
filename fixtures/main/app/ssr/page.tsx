import { Suspense } from "react";
import { connection } from "next/server";

// Dynamic hole: connection() opts this subtree out of the static shell, so it streams
// per-request (PPR resume) rather than being prerendered.
async function Now() {
  await connection();
  return <span data-testid="ssr-time">{new Date().toISOString()}</span>;
}

export default function Ssr() {
  return (
    <main>
      <h1 data-testid="ssr">SSR (PPR)</h1>
      <p>
        Static shell, streamed dynamic time:{" "}
        <Suspense fallback={<span>…</span>}>
          <Now />
        </Suspense>
      </p>
    </main>
  );
}
