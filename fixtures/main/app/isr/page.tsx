import { cacheLife, cacheTag } from "next/cache";

async function generated() {
  "use cache";
  cacheLife("minutes");
  cacheTag("isr");
  return new Date().toISOString();
}

export default async function Isr() {
  const at = await generated();
  return (
    <main>
      <h1 data-testid="isr">ISR (use cache)</h1>
      <p>
        Generated at <span data-testid="isr-time">{at}</span> (use cache, tag=isr) — POST
        /api/revalidate?tag=isr to refresh
      </p>
    </main>
  );
}
