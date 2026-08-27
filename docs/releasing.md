# Releasing

The release artifact is the npm tarball, not the repository checkout. Every release must pass the unit, type, lint, formatting, Kubernetes-schema, build, and packed-artifact gates:

```bash
npm run release:check
```

`test:package` packs with lifecycle scripts disabled, checks the public file set, then installs the tarball and the supported Next peer in an OS-temporary consumer. It resolves and imports every public export and runs the installed CLI, with no path back to this checkout's `node_modules`.

## Publish 0.1.x

1. Update `version` in the root package and every workspace-linked fixture lockfile. Run `npm run release:check` from a clean checkout.
2. Merge the release pull request. Create and publish a GitHub Release whose tag is exactly `v<package.json version>` and points to a commit on `main`; the workflow verifies both conditions.
3. Configure npm trusted publishing for `nextjs/adapter-k8s` and workflow `release.yml`. Protect the repository's `npm` environment with the required maintainers. The workflow uses that environment, a GitHub-hosted runner, `id-token: write`, a pinned OIDC-capable npm CLI, public access, and provenance.
4. The package does not exist on npm yet. If npm requires a token for the one-time first publication, add a short-lived `NPM_TOKEN` repository secret owned by an authorized `@next-community` maintainer, publish the GitHub Release, then configure the trusted publisher and delete the secret. Later releases use OIDC without a stored write token.
5. Confirm the npm artifact and provenance, then update README's unpublished wording and record the released commit in [verification](./verification.md).

Do not publish from an unmerged pull-request checkout. Do not widen the Next.js peer range as part of a version bump: each Next release line needs its own compatibility receipt first.
