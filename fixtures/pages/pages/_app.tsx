import type { AppContext, AppProps } from "next/app";
import App from "next/app";

export default function PagesApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}

PagesApp.getInitialProps = async (context: AppContext) => App.getInitialProps(context);
