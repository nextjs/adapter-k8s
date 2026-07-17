export default async function Target({
  params,
}: {
  params: Promise<{ locale: string; username: string; id: string }>;
}) {
  const { locale, username, id } = await params;
  return <span>{`target:${locale}:${username}:${id}`}</span>;
}
