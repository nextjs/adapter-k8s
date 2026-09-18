"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useActionState, useEffect, useState } from "react";
import { recordSubmission } from "./actions";

const LazyPanel = dynamic(() => import("./lazy"), { ssr: false });

export default function ContinuityClient() {
  const [hydrated, setHydrated] = useState(false);
  const [showLazy, setShowLazy] = useState(false);
  const [result, submit, pending] = useActionState(recordSubmission, "");
  useEffect(() => setHydrated(true), []);
  return (
    <main data-testid="continuity" data-hydrated={hydrated}>
      <p data-testid="continuity-version">
        {process.env.NEXT_PUBLIC_CONTINUITY_VERSION ?? "unversioned"}
      </p>
      <Link href="/continuity/destination" prefetch={false} data-testid="continuity-navigate">
        Navigate after deployment
      </Link>
      <button data-testid="continuity-load" onClick={() => setShowLazy(true)}>
        Load a new chunk
      </button>
      {showLazy && <LazyPanel />}
      <form action={submit}>
        <input name="message" defaultValue="draft" />
        <button data-testid="continuity-submit" disabled={pending}>
          Submit once
        </button>
        <output data-testid="continuity-result">{result}</output>
      </form>
    </main>
  );
}
