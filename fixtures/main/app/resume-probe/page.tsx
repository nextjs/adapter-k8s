import { Suspense } from "react";
import { connection } from "next/server";
import { headers } from "next/headers";
import { cacheTag } from "next/cache";

// A PPR route built to make resumption OBSERVABLE. The static shell (preamble) is prerendered and
// cached; the dynamic hole waits `x-resume-delay` ms before resolving. Streaming a request and
// timestamping chunks then shows the preamble bytes arriving well before the delayed hole bytes —
// i.e. the shell is flushed and the dynamic hole is resumed/streamed onto it, not blocked on.

// Static preamble, baked into the shell and shared cross-replica via the incremental cache.
async function Preamble() {
  "use cache";
  cacheTag("resume-shell");
  return (
    <p data-testid="preamble">
      preamble-cached-at:{new Date().toISOString()} pod:{process.env.HOSTNAME ?? "?"}
    </p>
  );
}

// Dynamic hole — resolves after a caller-controlled delay so the stream timeline is measurable.
async function Hole() {
  await connection();
  const h = await headers();
  const delay = Math.min(Math.max(Number(h.get("x-resume-delay") ?? "0") || 0, 0), 10_000);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  return (
    <p data-testid="hole">
      hole-resolved-at:{new Date().toISOString()} delay:{delay} pod:{process.env.HOSTNAME ?? "?"}
    </p>
  );
}

export default function ResumeProbe() {
  return (
    <main>
      <h1 data-testid="resume-probe">Resume Probe (PPR)</h1>
      <Preamble />
      <Suspense fallback={<p data-testid="hole-fallback">resolving-hole…</p>}>
        <Hole />
      </Suspense>
    </main>
  );
}
