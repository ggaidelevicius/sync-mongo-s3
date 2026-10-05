import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('the published package includes its CLI and documentation without development files', (t) => {
  const cache = mkdtempSync(path.join(os.tmpdir(), 'sync-package-'))
  t.after(() => rmSync(cache, { recursive: true, force: true }))
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, npm_config_cache: cache },
  })
  assert.equal(result.status, 0, result.stderr)
  const [packed] = JSON.parse(result.stdout)
  const files = packed.files.map((file) => file.path)
  for (const required of ['dist/index.js', 'package.json', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(required), `${required} is missing from the package`)
  }
  assert.ok(
    files.every((file) => /^(dist\/.*\.js|package\.json|README\.md|LICENSE)$/.test(file)),
    `Unexpected published files: ${files.join(', ')}`,
  )
  assert.match(
    readFileSync(path.join(root, 'dist/index.js'), 'utf8'),
    /^#!\/usr\/bin\/env node\r?\n/,
  )
})
