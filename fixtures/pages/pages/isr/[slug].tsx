import type { GetStaticPaths, GetStaticProps } from "next";

type Props = { slug: string; generatedAt: string };

export default function IsrPage({ slug, generatedAt }: Props) {
  return (
    <main>
      <p id="isr-slug">{slug}</p>
      <p id="isr-generated-at">{generatedAt}</p>
    </main>
  );
}

export const getStaticPaths: GetStaticPaths = async () => ({ paths: [], fallback: "blocking" });

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => ({
  props: {
    slug: String(params?.slug ?? ""),
    generatedAt: new Date().toISOString(),
  },
  revalidate: 30,
});
