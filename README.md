# Next.js K8S Deployment Adapter

This repo contains the K8S deployment adapter for Next.js.

```sh
npm i -D @next-community/adapter-k8s
```

```ts
// next.config.ts
import { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    adapterPath: require.resolve("@next-community/adapter-k8s"),
  },
};

export default nextConfig;
```

```sh
npx @next-community/adapter-k8s init
```

```sh
npx @next-community/adapter-k8s deploy
```

```sh
npx @next-community/adapter-k8s doctor
```
