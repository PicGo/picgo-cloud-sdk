import assert from 'node:assert/strict'
import test from 'node:test'
import { validateRelease } from './release.mjs'

const release = {
  manifest: { name: '@picgo/cloud-sdk', version: '0.1.0', repository: { url: 'git+https://github.com/PicGo/picgo-cloud-sdk.git' } },
  tag: 'v0.1.0', repository: 'PicGo/picgo-cloud-sdk', isPrivate: 'false',
}

test('stable releases use latest and prereleases use next', () => {
  assert.deepEqual(validateRelease(release), { version: '0.1.0', distTag: 'latest' })
  assert.deepEqual(validateRelease({ ...release, tag: 'v0.2.0-beta.1', manifest: { ...release.manifest, version: '0.2.0-beta.1' } }), {
    version: '0.2.0-beta.1', distTag: 'next',
  })
})

test('release tag must match a valid package version exactly', () => {
  for (const tag of ['0.1.0', 'v0.2.0', 'v0.1.0\n']) assert.throws(() => validateRelease({ ...release, tag }))
  for (const version of ['01.0.0', '0.1.0-beta.01', '0.1.0+build', '0.1.0\n']) {
    assert.throws(() => validateRelease({ ...release, tag: `v${version}`, manifest: { ...release.manifest, version } }))
  }
})

test('only the public canonical repository can release this package', () => {
  assert.throws(() => validateRelease({ ...release, repository: 'someone/picgo-cloud-sdk' }))
  assert.throws(() => validateRelease({ ...release, isPrivate: 'true' }))
  assert.throws(() => validateRelease({ ...release, isPrivate: undefined }))
  assert.throws(() => validateRelease({ ...release, manifest: { ...release.manifest, private: true } }))
  assert.throws(() => validateRelease({ ...release, manifest: { ...release.manifest, name: '@someone/cloud-sdk' } }))
  assert.throws(() => validateRelease({ ...release, manifest: { ...release.manifest, repository: { url: 'https://github.com/someone/other' } } }))
})
