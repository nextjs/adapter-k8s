export async function POST(request: Request) {
  const body = (await request.json()) as { value?: string };
  return Response.json({ received: body.value ?? null });
}
