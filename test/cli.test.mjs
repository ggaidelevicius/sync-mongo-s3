import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const mongoArgs = [
  '--remote-uri',
  'mongodb://reader:secret@remote.example/source',
  '--local-uri',
  'mongodb://writer:secret@localhost/auth',
  '--local-db',
  'development',
]

function fixture(t, files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sync-cli-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content)
  const log = path.join(root, 'calls.jsonl')
  for (const command of ['aws', 'mongodump', 'mongorestore']) {
    writeFileSync(
      path.join(bin, command),
      `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const command = ${JSON.stringify(command)}
const args = process.argv.slice(2)
appendFileSync(process.env.TEST_LOG, JSON.stringify({command, args, region: process.env.AWS_REGION, defaultRegion: process.env.AWS_DEFAULT_REGION, pager: process.env.AWS_PAGER, autoPrompt: process.env.AWS_CLI_AUTO_PROMPT}) + '\\n')
if (args[0] === '--version') {
  if (process.env.TEST_VERSION_FAIL === command) { console.error('broken executable'); process.exit(7) }
  console.log('test version'); process.exit(0)
}
if (process.env.TEST_FAIL === command) { console.error('simulated failure'); process.exit(9) }
if (process.env.TEST_SIGNAL === command) process.kill(process.pid, 'SIGTERM')
if (command === 'mongodump') {
  const out = args.find(arg => arg.startsWith('--out=')).slice(6)
  mkdirSync(path.join(out, 'source'), { recursive: true })
  writeFileSync(path.join(out, 'source', 'documents.bson'), 'fixture dump')
}
if (command === 'aws') {
  if (args[0] === 's3api') console.log(process.env.TEST_JSON ?? '{"KeyCount":0}')
  if (args[0] === 's3') writeFileSync(path.join(args[3], 'download.txt'), 'fixture download')
}
`,
      { mode: 0o755 },
    )
  }
  // Fake command entrypoints use ESM regardless of the temporary parent directory.
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  return {
    root,
    run(args, env = {}) {
      return spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        env: {
          PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
          HOME: root,
          TEST_LOG: log,
          ...env,
        },
        encoding: 'utf8',
        timeout: 15_000,
      })
    },
    calls() {
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
    },
  }
}

function succeeds(result) {
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
}

test('flags work without env files, and dry run performs no external commands or writes', (t) => {
  const f = fixture(t)
  const result = f.run(['--dry-run', '--skip-s3', ...mongoArgs])
  succeeds(result)
  assert.match(result.stdout, /Mongo source: source/)
  assert.match(result.stdout, /--stopOnError/)
  assert.doesNotMatch(result.stdout + result.stderr, /secret/)
  assert.deepEqual(f.calls(), [])
  assert.equal(existsSync(path.join(f.root, '.env.local')), false)
})

test('exported environment is sufficient, even when env files contain empty placeholders', (t) => {
  const f = fixture(t, { '.env': 'SYNC_REMOTE_MONGO_URI=""\nSYNC_LOCAL_MONGO_URI=""\n' })
  succeeds(
    f.run(['--dry-run', '--skip-s3'], {
      SYNC_REMOTE_MONGO_URI: 'mongodb://remote.example/source',
      SYNC_LOCAL_MONGO_URI: 'mongodb://localhost/development',
    }),
  )
})

test('S3-only mode does not parse or require MongoDB configuration', (t) => {
  const f = fixture(t)
  succeeds(
    f.run(['--skip-mongo', '--dry-run', '--s3-bucket', 'assets'], {
      SYNC_REMOTE_MONGO_URI: 'not-a-mongo-uri',
      SYNC_LOCAL_MONGO_URI: 'also-invalid',
    }),
  )
})

test('dotenv parsing supports quoted comments and preserves configuration precedence', (t) => {
  const f = fixture(t, {
    '.env.local':
      'export SYNC_S3_BUCKET="local-assets" # selected\nSYNC_S3_PREFIX="media#one" # comment\n',
    '.env': 'SYNC_S3_BUCKET=lower-priority\n',
  })
  const result = f.run(['--skip-mongo', '--dry-run'])
  succeeds(result)
  assert.match(result.stdout, /s3:\/\/local-assets\/media#one/)
  const override = f.run(['--skip-mongo', '--dry-run', '--s3-bucket', 'flag-assets'], {
    SYNC_S3_BUCKET: 'exported-assets',
  })
  succeeds(override)
  assert.match(override.stdout, /s3:\/\/flag-assets/)
})

test('empty higher-priority env values do not load lower-priority production values', (t) => {
  const f = fixture(t, {
    '.env.local': 'SYNC_S3_BUCKET=""\n',
    '.env': 'SYNC_S3_BUCKET=lower-priority\n',
  })
  const result = f.run(['--skip-mongo', '--dry-run'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /S3 bucket is required/)
})

test('production and example env files are never loaded implicitly', (t) => {
  const f = fixture(t, {
    '.env.production': 'SYNC_S3_BUCKET=production\n',
    '.env.example': 'SYNC_S3_BUCKET=example\n',
  })
  const result = f.run(['--skip-mongo', '--dry-run'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /S3 bucket is required/)
})

test('explicit init works noninteractively, preserves existing content, and is idempotent', (t) => {
  const f = fixture(t, { '.env': 'UNRELATED=keep' })
  succeeds(f.run(['--init']))
  const content = readFileSync(path.join(f.root, '.env'), 'utf8')
  assert.match(content, /^UNRELATED=keep\n/)
  assert.equal((content.match(/SYNC_REMOTE_MONGO_URI=/g) ?? []).length, 1)
  succeeds(f.run(['--init']))
  assert.equal(readFileSync(path.join(f.root, '.env'), 'utf8'), content)
  assert.deepEqual(f.calls(), [])
})

test('init creates a private local env file without touching production templates', (t) => {
  const f = fixture(t, { '.env.example': '# template' })
  succeeds(f.run(['--init']))
  assert.equal(statSync(path.join(f.root, '.env.local')).mode & 0o777, 0o600)
  assert.equal(readFileSync(path.join(f.root, '.env.example'), 'utf8'), '# template')
})

test('help ignores unreadable env paths and does not invoke tooling', (t) => {
  const f = fixture(t)
  mkdirSync(path.join(f.root, '.env.local'))
  succeeds(f.run(['--help']))
  assert.deepEqual(f.calls(), [])
})

test('invalid modes and unknown flags fail before running commands or creating files', (t) => {
  for (const args of [
    ['--skip-mongo', '--skip-s3'],
    ['--dry-run', '--check'],
    ['--init', '--dry-run'],
    ['--unknown'],
    ['--remote-uri'],
  ]) {
    const f = fixture(t)
    const result = f.run(args)
    assert.equal(result.status, 1, args.join(' '))
    assert.deepEqual(f.calls(), [])
    assert.equal(existsSync(path.join(f.root, '.env.local')), false)
  }
})

test('an empty prefix overrides a configured prefix and targets the whole bucket', (t) => {
  const f = fixture(t)
  const result = f.run(['--skip-mongo', '--dry-run', '--s3-bucket', 'assets', '--s3-prefix='], {
    SYNC_S3_PREFIX: 'media',
  })
  succeeds(result)
  assert.match(result.stdout, /S3 source: s3:\/\/assets\n/)
})

test('preferred false rewrite flag is not overridden by a legacy true alias', (t) => {
  const f = fixture(t)
  const result = f.run(['--dry-run', '--skip-s3', ...mongoArgs], {
    SYNC_MEDIA_URL_REWRITE_HOST: 'cdn.example.com',
    SYNC_MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT: 'false',
    MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT: 'true',
  })
  succeeds(result)
  assert.match(result.stdout, /Drop first path segment: no/)
})

test('S3 check uses the selected bucket and prefix without requiring account-wide discovery', (t) => {
  const f = fixture(t)
  succeeds(f.run(['--check', '--skip-mongo', '--s3-bucket', 'assets', '--s3-prefix', 'media']))
  const calls = f.calls()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args, [
    's3api',
    'list-objects-v2',
    '--bucket',
    'assets',
    '--max-keys',
    '1',
    '--no-paginate',
    '--output',
    'json',
    '--prefix',
    'media/',
  ])
  assert.equal(existsSync(path.join(f.root, 's3-bucket')), false)
})

test('S3 region override wins and disables CLI paging and auto-prompt', (t) => {
  const f = fixture(t)
  succeeds(
    f.run(['--skip-mongo', '--s3-bucket', 'assets'], {
      SYNC_AWS_REGION: 'ap-southeast-2',
      AWS_DEFAULT_REGION: 'us-east-1',
      AWS_PAGER: 'pager',
      AWS_CLI_AUTO_PROMPT: 'on',
    }),
  )
  const call = f.calls().at(-1)
  assert.equal(call.region, 'ap-southeast-2')
  assert.equal(call.defaultRegion, 'ap-southeast-2')
  assert.equal(call.pager, '')
  assert.equal(call.autoPrompt, 'off')
  assert.equal(
    readFileSync(path.join(f.root, 's3-bucket/download.txt'), 'utf8'),
    'fixture download',
  )
})

test('failed executable preflight stops before dump or restore', (t) => {
  const f = fixture(t)
  const result = f.run(['--skip-s3', ...mongoArgs], { TEST_VERSION_FAIL: 'mongorestore' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /mongorestore exited with code 7/)
  assert.ok(f.calls().every((call) => call.args[0] === '--version'))
})

test('failed S3 access prevents MongoDB mutation', (t) => {
  const f = fixture(t)
  const result = f.run([...mongoArgs, '--s3-bucket', 'assets'], { TEST_FAIL: 'aws' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /simulated failure/)
  assert.ok(
    f
      .calls()
      .filter((call) => call.command !== 'aws')
      .every((call) => call.args[0] === '--version'),
  )
})

test('invalid JSON from AWS fails clearly without syncing', (t) => {
  const f = fixture(t)
  const result = f.run(['--skip-mongo', '--s3-bucket', 'assets'], { TEST_JSON: 'not JSON' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /aws returned invalid JSON/)
  assert.equal(existsSync(path.join(f.root, 's3-bucket')), false)
})

test('dump and restore use correct auth databases, namespace mapping, and temporary cleanup', (t) => {
  const f = fixture(t)
  succeeds(f.run(['--skip-s3', ...mongoArgs, '--temp-dir', './dumps']))
  const calls = f.calls().filter((call) => call.args[0] !== '--version')
  assert.equal(calls.length, 2)
  assert.match(calls[0].args[0], /\/source\?authSource=source$/)
  assert.match(calls[1].args[0], /localhost\/\?authSource=auth$/)
  assert.ok(calls[1].args.includes('--stopOnError'))
  assert.ok(calls[1].args.includes('--nsFrom=source.*'))
  assert.ok(calls[1].args.includes('--nsTo=development.*'))
  assert.equal(calls[1].args.at(-1), calls[0].args.find((arg) => arg.startsWith('--out=')).slice(6))
  assert.deepEqual(readdirSync(path.join(f.root, 'dumps')), [])
})

test('dump failure prevents restore and always cleans temporary data', (t) => {
  const f = fixture(t)
  const result = f.run(['--skip-s3', ...mongoArgs, '--temp-dir', './dumps'], {
    TEST_FAIL: 'mongodump',
  })
  assert.equal(result.status, 1)
  assert.ok(
    f
      .calls()
      .filter((call) => call.command === 'mongorestore')
      .every((call) => call.args[0] === '--version'),
  )
  assert.deepEqual(readdirSync(path.join(f.root, 'dumps')), [])
})

test('restore failure prevents S3 sync and keep-dump retains recovery data', (t) => {
  const f = fixture(t)
  const result = f.run(
    [...mongoArgs, '--s3-bucket', 'assets', '--temp-dir', './dumps', '--keep-dump'],
    { TEST_FAIL: 'mongorestore' },
  )
  assert.equal(result.status, 1)
  assert.match(result.stdout, /Preserved MongoDB dump at/)
  assert.equal(readdirSync(path.join(f.root, 'dumps')).length, 1)
  assert.ok(f.calls().every((call) => call.args[0] !== 's3'))
})

test('signal termination is reported as a failure and temporary data is cleaned', (t) => {
  const f = fixture(t)
  const result = f.run(['--skip-s3', ...mongoArgs, '--temp-dir', './dumps'], {
    TEST_SIGNAL: 'mongorestore',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /mongorestore was terminated by SIGTERM/)
  assert.deepEqual(readdirSync(path.join(f.root, 'dumps')), [])
})

test('same database targets, system databases, and namespace patterns fail before commands', (t) => {
  for (const args of [
    ['--remote-uri', 'mongodb://localhost/source', '--local-uri', 'mongodb://127.0.0.1/source'],
    [...mongoArgs, '--local-db', 'admin'],
    [...mongoArgs, '--remote-db', '*'],
  ]) {
    const f = fixture(t)
    assert.equal(f.run(['--skip-s3', ...args]).status, 1)
    assert.deepEqual(f.calls(), [])
  }
})
