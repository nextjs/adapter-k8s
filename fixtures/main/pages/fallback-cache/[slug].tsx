import { useRouter } from "next/router";
import type { GetStaticPaths, GetStaticProps } from "next";

export default function FallbackCachePage({ slug }: { slug: string }) {
  const router = useRouter();
  if (router.isFallback) {
    return <p data-testid="fallback-cache-shell">fallback-cache-shell</p>;
  }
  return <p data-testid="fallback-cache-value">fallback-cache-materialized:{slug}</p>;
}

export const getStaticPaths: GetStaticPaths = async () => ({ paths: [], fallback: true });

export const getStaticProps: GetStaticProps = async ({ params }) => ({
  props: { slug: String(params?.slug ?? "") },
  revalidate: 60,
});
