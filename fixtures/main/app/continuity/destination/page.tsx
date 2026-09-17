import { connection } from "next/server";
import { Suspense } from "react";

async function Destination() {
  await connection();
  return (
    <p data-testid="continuity-destination">
      {process.env.NEXT_PUBLIC_CONTINUITY_VERSION ?? "unversioned"}
    </p>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p>Loading destination</p>}>
      <Destination />
    </Suspense>
  );
}
