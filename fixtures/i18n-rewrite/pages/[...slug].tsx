import type { GetStaticPaths, GetStaticProps } from "next";

type Props = { locale: string; slug: string[] };

export default function Page({ locale, slug }: Props) {
  return <main id="rewrite-result">{JSON.stringify({ locale, slug })}</main>;
}

export const getStaticPaths: GetStaticPaths = async ({ locales = [] }) => ({
  fallback: false,
  paths: locales.flatMap((locale) => [
    { locale, params: { slug: ["hello"] } },
    { locale, params: { slug: ["company", "about-us"] } },
  ]),
});

export const getStaticProps: GetStaticProps<Props> = async ({ locale, params }) => ({
  props: {
    locale: locale ?? "unknown",
    slug: params?.slug as string[],
  },
});
