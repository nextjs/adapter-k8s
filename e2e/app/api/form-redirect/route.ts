export function POST(request: Request) {
  return Response.redirect(new URL("/form-redirect-target?success=true", request.url), 307);
}
