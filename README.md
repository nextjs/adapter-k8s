# Next.js K8S Deployment Adapter

This repo contains the K8S deployment adapter for Next.js.

```sh
npm i @next-community/adapter-k8s@latest
```

```ts
// next.config.ts
import { NextConfig } from 'next' 

const nextConfig: NextConfig = {
  experimental: {
    adapterPath: require.resolve('@next-community/adapter-k8s')
  }
}

export default nextConfig
```
