export default async function Intercepted({
  params,
}: {
  params: Promise<{ locale: string; username: string; id: string }>;
}) {
  const { locale, username, id } = await params;
  return <span>{`intercepted:${locale}:${username}:${id}`}</span>;
}
