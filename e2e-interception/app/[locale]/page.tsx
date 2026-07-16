"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    // The live fixture opts into one automatic client navigation so headless Chromium can exercise
    // the interception protocol without coupling this repository to a browser-driver package.
    if (new URLSearchParams(window.location.search).get("navigate") === "1") {
      router.push("/probe-user/p/1");
    }
  }, [router]);

  return <Link href="/probe-user/p/1">Open intercepted route</Link>;
}
