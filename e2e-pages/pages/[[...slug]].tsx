import type { GetServerSideProps } from "next";

type Props = { slug: string[] | null };

export default function OptionalCatchall({ slug }: Props) {
  return <main id="optional-catchall-slug">{JSON.stringify(slug)}</main>;
}

export const getServerSideProps: GetServerSideProps<Props> = async ({ params, resolvedUrl }) => {
  if (resolvedUrl === "/definitely-missing") return { notFound: true };
  const slug = params?.slug;
  return { props: { slug: Array.isArray(slug) ? slug : slug ? [slug] : null } };
};
