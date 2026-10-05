import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { getReleaseBump } from '../scripts/validate-commit-msg.mjs'

test('ordinary commit messages do not select a release', () => {
  assert.equal(getReleaseBump('Improve database selection'), undefined)
})

test('a single release marker selects its exact version bump', () => {
  for (const bump of ['patch', 'minor', 'major']) {
    assert.equal(getReleaseBump(`Improve database selection (release:${bump})`), bump)
  }
})

test('malformed, duplicated, and contradictory release markers are rejected', () => {
  for (const message of [
    '(release:patch) (release:minor)',
    '(release:patch) (release:patch)',
    '(release:patch) (release:invalid)',
    '(release:patch) (release:minor',
    '(release:patch)\n(release',
    '(release)',
    '(release:patch',
    '(release:PATCH)',
    '(release: patch)',
    '(release:patch extra)',
  ]) {
    assert.throws(() => getReleaseBump(message), /Use exactly one of/, message)
  }
})

test('the release CLI validates a file and prints only the selected bump', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sync-release-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const messagePath = path.join(directory, 'COMMIT_EDITMSG')
  const script = fileURLToPath(new URL('../scripts/validate-commit-msg.mjs', import.meta.url))
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

  writeFileSync(messagePath, 'Handle literal `commands` and $(substitutions) (release:minor)')
  const release = run(messagePath, '--release')
  assert.equal(release.status, 0, release.stderr)
  assert.equal(release.stdout, 'minor\n')

  writeFileSync(messagePath, 'Improve help text')
  assert.equal(run(messagePath).status, 0)
  assert.equal(run(messagePath, '--release').status, 1)

  writeFileSync(messagePath, '(release:patch) (release')
  const invalid = run(messagePath)
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /\[sync-mongo-s3\]/)
  assert.equal(run().status, 1)
  assert.equal(run(path.join(directory, 'missing')).status, 1)
})
