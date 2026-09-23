# Publishing @picgo/cloud-sdk

This document is for package maintainers. Application integration is documented in the root README.

## First publication

The npm package must exist before configuring its trusted publisher. If `@picgo/cloud-sdk` has not been published yet, a maintainer with publish access to the npm `@picgo` organization can publish the first version locally. A manually created access token is not required: interactive `npm login` and account 2FA work. If the first publication must run non-interactively, use an appropriately scoped granular access token with publishing access and bypass 2FA enabled, then remove that credential after setting up OIDC.

Make the GitHub repository public and merge the SDK and publishing workflow into `main` before releasing. From a clean checkout of `main`, using Node.js 24:

```sh
pnpm install --frozen-lockfile
npm login --registry=https://registry.npmjs.org
npm publish --access public
```

The existing `prepublishOnly` script runs the full checks and build before this manual publication. Complete npm's 2FA prompt. This creates the package; it does not need a GitHub secret or a bootstrap workflow. Do not push a release tag for this already-published version to trigger another publication of the same version. Local publication does not carry the GitHub Actions provenance that subsequent OIDC releases will provide.

## Configure the npm trusted publisher

Open the npm package settings for `@picgo/cloud-sdk`, add a GitHub Actions trusted publisher, and use these exact values:

| Field | Value |
| --- | --- |
| Organization or user | `PicGo` |
| Repository | `picgo-cloud-sdk` |
| Workflow filename | `publish.yml` |
| Environment name | Leave blank; this workflow does not specify one |
| Allowed actions | Enable direct publishing with `npm publish` |

The workflow filename must include the extension but not `.github/workflows/`. Current npm configurations default to allowing staged publishing; explicitly enable direct `npm publish` for this workflow. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is needed. The publish job requests `id-token: write` and runs on a GitHub-hosted runner. It installs npm 11, which supports OIDC (minimum supported version: 11.5.1).

After verifying the first OIDC publication, remove unused publishing tokens. You may also enable npm's “Require two-factor authentication and disallow tokens” setting; trusted publishing continues to work with that setting.

## Subsequent releases

This repository uses `@picgo/bump-version`, matching PicGo-Core. Use `pnpm cz` to write commits in the PicGo format; the commit-message hook validates them. For example:

```text
:sparkles: Feature(upload): add resumable uploads
:bug: Fix(media): preserve the current media URL
```

The changelog generator recognizes this convention. Earlier Angular-style commits are not automatically converted. Use a PicGo-format title when squash-merging a feature PR so its change appears in the changelog.

Preview the next release without changing files, creating a commit, or tagging:

```sh
pnpm release:dry
pnpm release:dry --type minor
```

From a clean, up-to-date `main`, run `pnpm release` to update the version, generate `CHANGELOG.md`, create a release commit, and create the annotated `v<version>` tag. For example, when the current version is `0.1.0`:

```sh
git switch main
git pull --ff-only
pnpm release --type patch
git push origin main
git push origin v0.1.1
```

Use `pnpm release --version 0.2.0-beta.1` for an exact prerelease version, or add `--yes` to skip the version confirmation. Review the resulting version and changelog before pushing. The release command prepares the Git release; the tag push triggers npm publication. Do not use bump-version's `--push` here: version 3.0.0 hardcodes `origin master`, while this repository uses `main`.

If changes to `main` require a pull request, run `pnpm release --no-tag` on a release branch, merge the version/changelog commit, and create the corresponding tag on the merged `main` commit. The tag must point to the commit that contains the published version.

Pushing a `v*` tag starts `.github/workflows/publish.yml`. It checks that the repository is public, the tag exactly matches `v<package.json version>`, and the tagged commit is already in `main`. It then installs locked dependencies, runs type checking, lint, tests, and the build, and packs the result. A separate job publishes that verified tarball using OIDC and provenance, without rerunning package scripts in the publishing job.

Stable versions publish to the `latest` dist-tag. Prerelease versions such as `0.2.0-beta.1` publish to `next`. Ordinary pushes and pull requests run CI but do not publish. Existing npm versions cannot be overwritten; increment the version for another release. To retry a transient failure before the package was published, rerun the failed workflow in GitHub Actions.

## Local validation without publishing

```sh
pnpm check
pnpm pack --pack-destination .release
npm publish .release/picgo-cloud-sdk-0.1.0.tgz --dry-run --ignore-scripts --access public
```

Replace the tarball version with the version being tested. These commands build and inspect the package without publishing it. The package allowlist contains only `dist`, the two READMEs, `CHANGELOG.md` once generated, and the license, plus npm's required package metadata; local `.env` files, examples, and maintenance scripts are not shipped.

## References

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
- [Publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)
