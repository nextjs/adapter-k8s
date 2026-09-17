"use server";

import { cookies } from "next/headers";

export async function recordSubmission(_previous: string, form: FormData) {
  const jar = await cookies();
  const count = Number(jar.get("continuity-submissions")?.value ?? "0") + 1;
  jar.set("continuity-submissions", String(count), {
    httpOnly: true,
    sameSite: "lax",
    path: "/continuity",
  });
  return `${process.env.NEXT_PUBLIC_CONTINUITY_VERSION ?? "unversioned"}:${count}:${String(form.get("message"))}`;
}
