import { connection } from "next/server";
import { Suspense } from "react";

async function EncodedKey({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  await connection();
  const { key } = await params;
  return (
    <main>
      <h1>Encoded dynamic parameter</h1>
      <p data-testid="encoded-key">encoded-key:{key}</p>
    </main>
  );
}

export default function EncodedKeyPage({ params }: { params: Promise<{ key: string }> }) {
  return (
    <Suspense fallback={<p>encoded-key-loading</p>}>
      <EncodedKey params={params} />
    </Suspense>
  );
}
