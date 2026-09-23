import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

export function validateRelease({ manifest, tag, repository, isPrivate }) {
  if (repository !== 'PicGo/picgo-cloud-sdk') throw new Error('Releases must originate from PicGo/picgo-cloud-sdk')
  if (isPrivate !== 'false') throw new Error('Make the GitHub repository public before publishing with provenance')
  if (manifest.name !== '@picgo/cloud-sdk') throw new Error('Unexpected npm package name')
  if (manifest.repository?.url !== 'git+https://github.com/PicGo/picgo-cloud-sdk.git') {
    throw new Error('package.json repository.url must match the trusted publisher repository')
  }
  if (manifest.private) throw new Error('Cannot publish a private package')
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    throw new Error('Use a valid package version without build metadata')
  }
  if (tag !== `v${manifest.version}`) throw new Error('The release tag must exactly match v<package.json version>')
  return { version: manifest.version, distTag: manifest.version.includes('-') ? 'next' : 'latest' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const result = validateRelease({
    manifest,
    tag: process.env.RELEASE_TAG,
    repository: process.env.RELEASE_REPOSITORY,
    isPrivate: process.env.RELEASE_REPOSITORY_PRIVATE,
  })
  // Checkout fetches full history. A tag must point to a commit already merged into main.
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { stdio: 'inherit' })
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ndist-tag=${result.distTag}\n`)
  console.log(`Validated @picgo/cloud-sdk@${result.version} → ${result.distTag}`)
}
