#!/usr/bin/env node

import { MongoClient } from 'mongodb'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process, { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseEnv } from 'node:util'
import {
  buildMongoDumpArgs,
  buildMongoRestoreArgs,
  extractDatabaseName,
  prepareMongoToolUri,
  rewriteMongoUriDatabase,
  validateMongoTargets,
} from './mongo.js'
import { rewriteMediaUrlsForLocalDevelopment } from './media.js'

type Options = {
  check: boolean
  dryRun: boolean
  help: boolean
  init: boolean
  interactive: boolean
  keepDump: boolean
  rewriteMediaDropFirstSegment: boolean
  rewriteMediaHost?: string
  s3Prefix?: string
  s3Bucket?: string
  skipMongo: boolean
  skipS3: boolean
  tempDir?: string
  localDb?: string
  localUri?: string
  remoteDb?: string
  remoteUri?: string
}

type ResolvedOptions = Options & {
  s3Dest: string
}

type PromptContext = {
  ask(question: string, defaultValue?: string): Promise<string>
  confirm(question: string, defaultValue?: boolean): Promise<boolean>
  choose(
    question: string,
    choices: string[],
    defaultValue?: string,
    allowCustom?: boolean,
  ): Promise<string>
  close(): void
}

type EnvTemplateEntry = {
  key: string
  value: string
}

type SyncEnvAssignment = {
  file: string
  key: string
  value: string
}

type SyncEnvScanResult = {
  assignments: SyncEnvAssignment[]
  envFiles: string[]
}

const repoRoot = process.cwd()
const isInteractiveTty = Boolean(input.isTTY && output.isTTY)
const envFilePriority = ['.env.local', '.env.development.local', '.env.development', '.env']
const syncEnvTemplateEntries: EnvTemplateEntry[] = [
  { key: 'SYNC_REMOTE_MONGO_URI', value: '""' },
  { key: 'SYNC_LOCAL_MONGO_URI', value: '""' },
]

const usage = `Sync a remote MongoDB and S3 bucket into the local project.

Usage:
  sync-mongo-s3
  sync-mongo-s3 [options]

Options:
  --check                  Validate configuration, dependencies, and access without syncing
  --dry-run                Print the resolved sync plan and commands without executing them
  --init                   Initialize the minimum SYNC_* placeholders in the most relevant .env file
  --interactive            Prompt for missing values and list discoverable targets
  --remote-uri <uri>       Remote MongoDB URI
  --remote-db <name>       Remote MongoDB database name
  --local-uri <uri>        Local MongoDB URI (defaults to SYNC_LOCAL_MONGO_URI)
  --local-db <name>        Local MongoDB database name
  --s3-bucket <name>       S3 bucket name (defaults to SYNC_S3_BUCKET)
  --s3-prefix <prefix>     Optional bucket prefix to sync
  --rewrite-media-host <hostname>
                           Rewrite restored absolute media URLs from this host to /s3-bucket/...
  --rewrite-media-drop-first-segment
                           Drop the first source path segment during media URL rewriting
  --skip-mongo             Skip MongoDB dump/restore
  --skip-s3                Skip S3 sync
  --keep-dump              Keep the temporary mongodump directory
  --temp-dir <path>        Create the dump inside a specific base temp directory
  --help                   Show this message

Preferred environment variables:
  SYNC_REMOTE_MONGO_URI
  SYNC_REMOTE_MONGO_DB
  SYNC_LOCAL_MONGO_URI
  SYNC_LOCAL_MONGO_DB
  SYNC_S3_BUCKET
  SYNC_S3_PREFIX
  SYNC_AWS_REGION
  SYNC_MEDIA_URL_REWRITE_HOST
  SYNC_MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT

Examples:
  sync-mongo-s3 --init
  sync-mongo-s3 --check
  sync-mongo-s3 --dry-run
  sync-mongo-s3
  sync-mongo-s3 --remote-uri "mongodb+srv://..." --remote-db production --local-db development
  sync-mongo-s3 --skip-mongo --s3-bucket my-bucket --s3-prefix media
  sync-mongo-s3 --rewrite-media-host cdn.example.com --rewrite-media-drop-first-segment
`

await main()

async function main() {
  try {
    let options = parseArgs(process.argv.slice(2))

    if (options.help) {
      console.log(usage)
      return
    }

    loadEnvFiles(listEnvFiles())
    const prompt = isInteractiveTty ? createPromptContext() : undefined

    try {
      if (options.init) {
        await ensureSyncEnvInitialized()
        return
      }

      if (options.skipMongo && options.skipS3) {
        throw new Error('Nothing to do: both --skip-mongo and --skip-s3 were provided.')
      }

      if (
        prompt &&
        !options.check &&
        !options.dryRun &&
        !options.skipMongo &&
        (!(options.remoteUri ?? getConfiguredRemoteUri()) ||
          !(options.localUri ?? getConfiguredLocalUri()))
      ) {
        const result = await ensureSyncEnvInitialized(prompt)
        if (result.status !== 'not_needed') return
      }

      if (shouldPrompt(options) && prompt) {
        options = await completeOptionsInteractively(options, prompt)
      }
    } finally {
      prompt?.close()
    }

    const resolvedOptions = resolveOptions(options)

    if (options.dryRun) {
      printDryRunPlan(resolvedOptions)
      return
    }

    runPreflightChecks(resolvedOptions)

    if (options.check) {
      await runCheckMode(resolvedOptions)
      return
    }

    // Verify the S3 source before changing the local database.
    if (!resolvedOptions.skipS3) checkS3Access(resolvedOptions)

    if (!resolvedOptions.skipMongo) {
      await runMongoSync(resolvedOptions)
    }

    if (!resolvedOptions.skipS3) {
      runS3Sync(resolvedOptions)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(redactErrorMessage(message))
    process.exitCode = 1
  }
}

function shouldPrompt(options: Options) {
  if (!isInteractiveTty) {
    return false
  }

  if (options.check || options.init || options.dryRun) {
    return false
  }

  if (options.interactive) {
    return true
  }

  if (!options.skipMongo) {
    const remoteUri = options.remoteUri ?? getConfiguredRemoteUri()
    const localUri = options.localUri ?? getConfiguredLocalUri()
    const remoteDb =
      options.remoteDb ??
      getConfiguredRemoteDb() ??
      (options.skipMongo ? undefined : extractDatabaseName(remoteUri))
    const localDb =
      options.localDb ??
      getConfiguredLocalDb() ??
      (options.skipMongo ? undefined : extractDatabaseName(localUri)) ??
      'development'

    if (!remoteUri || !localUri || !remoteDb || !localDb) {
      return true
    }
  }

  if (!options.skipS3) {
    const hasBucket = Boolean(options.s3Bucket ?? getConfiguredS3Bucket())
    if (!hasBucket) {
      return true
    }
  }

  return false
}

function listEnvFiles() {
  // Only load development configuration; templates and production files are not defaults.
  return envFilePriority.filter((file) => {
    const fullPath = path.join(repoRoot, file)
    return existsSync(fullPath) && statSync(fullPath).isFile()
  })
}

function loadEnvFiles(files: string[]) {
  for (const file of files) {
    const envValues = parseEnv(readFileSync(path.join(repoRoot, file), 'utf8'))
    for (const [key, value] of Object.entries(envValues)) {
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
}

function scanSyncEnvFiles(): SyncEnvScanResult {
  const envFiles = listEnvFiles()
  const assignments: SyncEnvAssignment[] = []

  for (const file of envFiles) {
    const fullPath = path.join(repoRoot, file)
    if (!existsSync(fullPath)) {
      continue
    }

    for (const [key, value] of Object.entries(parseEnv(readFileSync(fullPath, 'utf8')))) {
      if (value !== undefined) assignments.push({ file, key, value })
    }
  }

  return { assignments, envFiles }
}

function findMissingSyncEnvEntries(scan: SyncEnvScanResult) {
  return syncEnvTemplateEntries.filter(
    (entry) => !scan.assignments.some((assignment) => assignment.key === entry.key),
  )
}

async function ensureSyncEnvInitialized(prompt?: PromptContext) {
  const scan = scanSyncEnvFiles()
  const missingEntries = findMissingSyncEnvEntries(scan)
  const targetFile = selectEnvTargetFile(scan.envFiles)

  if (missingEntries.length === 0) {
    if (!prompt)
      console.log('SYNC_* initialization is already present. No new placeholders were added.')
    return { scan, status: 'not_needed' as const, targetFile }
  }

  console.log(
    [
      'This project has not been initialized for sync-mongo-s3 yet.',
      `I can add placeholder SYNC_* keys to ${targetFile}:`,
      ...missingEntries.map((entry) => `  ${entry.key}=${entry.value}`),
      '',
      'You will need to replace these placeholders with your own project details before running the sync.',
    ].join('\n'),
  )

  const shouldWrite =
    !prompt || (await prompt.confirm(`Write these placeholder keys to ${targetFile}?`, true))
  if (!shouldWrite) {
    console.log(`Skipped writing SYNC_* placeholders to ${targetFile}.`)
    return { scan, status: 'cancelled' as const, targetFile }
  }

  writeEnvTemplateEntries(targetFile, missingEntries)

  console.log(
    [
      `Added ${missingEntries.length} SYNC_* placeholder key(s) to ${targetFile}:`,
      ...missingEntries.map((entry) => `  ${entry.key}`),
      '',
      'Fill these in with your own connection details, then run sync-mongo-s3 again.',
    ].join('\n'),
  )

  return { scan, status: 'written' as const, targetFile }
}

function selectEnvTargetFile(files: string[]) {
  for (const file of envFilePriority) {
    if (files.includes(file)) {
      return file
    }
  }

  return files[0] ?? '.env.local'
}

function writeEnvTemplateEntries(file: string, entries: EnvTemplateEntry[]) {
  const fullPath = path.join(repoRoot, file)
  const existingContent = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : ''

  let block = ''
  if (existingContent && !existingContent.endsWith('\n')) {
    block += '\n'
  }
  if (existingContent.trim()) {
    block += '\n'
  }

  block += '# Added by sync-mongo-s3 for first-run setup\n'
  block += '# Fill these in with your own project details before running the sync.\n'
  for (const entry of entries) {
    block += `${entry.key}=${entry.value}\n`
  }

  appendFileSync(fullPath, block, { encoding: 'utf8', mode: 0o600 })
}

async function runCheckMode(options: ResolvedOptions) {
  const lines = ['Running sync-mongo-s3 checks...']
  if (!options.skipMongo && options.remoteUri && options.localUri) {
    const remoteDatabases = await listMongoDatabasesStrict(options.remoteUri)
    if (!remoteDatabases.includes(options.remoteDb!)) {
      throw new Error(`Remote MongoDB database was not found: ${options.remoteDb}`)
    }
    const localDatabases = await listMongoDatabasesStrict(options.localUri)
    lines.push(
      `Mongo remote target: OK (${options.remoteDb} on ${redactMongoUri(options.remoteUri)})`,
      `Mongo local connection: OK (${redactMongoUri(options.localUri)})`,
      localDatabases.includes(options.localDb!)
        ? `Mongo local DB target: OK (${options.localDb})`
        : `Mongo local DB target: will be created (${options.localDb})`,
    )
  }
  if (!options.skipS3) {
    checkS3Access(options)
    lines.push(`S3 source listing: OK (${buildS3Source(options.s3Bucket!, options.s3Prefix)})`)
  }
  console.log(lines.join('\n'))
}

function checkS3Access(options: ResolvedOptions) {
  const args = [
    's3api',
    'list-objects-v2',
    '--bucket',
    options.s3Bucket!,
    '--max-keys',
    '1',
    '--no-paginate',
    '--output',
    'json',
  ]
  if (options.s3Prefix) args.push('--prefix', `${options.s3Prefix}/`)
  runCommandForJson('aws', args, buildAwsEnv())
}

function printDryRunPlan(options: ResolvedOptions) {
  const lines = ['Dry run only. No changes were made.', '', 'Resolved plan:']

  if (!options.skipMongo && options.remoteUri && options.remoteDb && options.localUri) {
    lines.push(
      `  Mongo source: ${options.remoteDb} on ${redactMongoUri(options.remoteUri)}`,
      `  Mongo target: ${options.localDb} on ${redactMongoUri(options.localUri)}`,
    )

    const remoteDumpUri = rewriteMongoUriDatabase(options.remoteUri, options.remoteDb)
    const localRestoreUri = rewriteMongoUriDatabase(options.localUri)

    lines.push(
      '',
      'Mongo commands:',
      `  $ ${formatCommandForLog('mongodump', buildMongoDumpArgs(remoteDumpUri, options.remoteDb, '<temp dump dir>'))}`,
      `  $ ${formatCommandForLog('mongorestore', buildMongoRestoreArgs(localRestoreUri, options.remoteDb, options.localDb!, '<temp dump dir>'))}`,
    )
  }

  if (!options.skipS3 && options.s3Bucket) {
    lines.push(
      `  S3 source: ${buildS3Source(options.s3Bucket, options.s3Prefix)}`,
      `  S3 target: ${options.s3Dest}`,
      '',
      'S3 command:',
      `  $ ${formatCommandForLog('aws', [
        's3',
        'sync',
        buildS3Source(options.s3Bucket, options.s3Prefix),
        options.s3Dest,
      ])}`,
    )
  }

  if (options.rewriteMediaHost) {
    lines.push(
      '',
      `Media URL rewrite host: ${options.rewriteMediaHost}`,
      `Drop first path segment: ${options.rewriteMediaDropFirstSegment ? 'yes' : 'no'}`,
    )
  }

  console.log(lines.join('\n'))
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    check: false,
    dryRun: false,
    help: false,
    init: false,
    interactive: false,
    keepDump: false,
    rewriteMediaDropFirstSegment: false,
    skipMongo: false,
    skipS3: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }

    if (argument === '--check') {
      options.check = true
      continue
    }

    if (argument === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (argument === '--init') {
      options.init = true
      continue
    }

    if (argument === '--interactive') {
      options.interactive = true
      continue
    }

    if (argument === '--keep-dump') {
      options.keepDump = true
      continue
    }

    if (argument === '--rewrite-media-drop-first-segment') {
      options.rewriteMediaDropFirstSegment = true
      continue
    }

    if (argument === '--skip-mongo') {
      options.skipMongo = true
      continue
    }

    if (argument === '--skip-s3') {
      options.skipS3 = true
      continue
    }

    if (!argument.startsWith('--')) {
      throw new Error(`Unknown argument: ${argument}`)
    }

    const separatorIndex = argument.indexOf('=')
    const flag = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex)
    if (
      ![
        '--remote-uri',
        '--remote-db',
        '--local-uri',
        '--local-db',
        '--s3-bucket',
        '--s3-prefix',
        '--rewrite-media-host',
        '--temp-dir',
      ].includes(flag)
    ) {
      throw new Error(`Unknown flag: ${flag}`)
    }
    const inlineValue = separatorIndex === -1 ? undefined : argument.slice(separatorIndex + 1)
    const value = inlineValue ?? argv[index + 1]
    if (
      value === undefined ||
      (flag !== '--s3-prefix' && !value.trim()) ||
      value.startsWith('--')
    ) {
      throw new Error(`Missing value for ${flag}`)
    }

    if (inlineValue === undefined) {
      index += 1
    }

    switch (flag) {
      case '--remote-uri':
        options.remoteUri = value
        break
      case '--remote-db':
        options.remoteDb = value
        break
      case '--local-uri':
        options.localUri = value
        break
      case '--local-db':
        options.localDb = value
        break
      case '--s3-bucket':
        options.s3Bucket = value
        break
      case '--s3-prefix':
        options.s3Prefix = value
        break
      case '--rewrite-media-host':
        options.rewriteMediaHost = value
        break
      case '--temp-dir':
        options.tempDir = value
        break
      default:
        throw new Error(`Unknown flag: ${flag}`)
    }
  }

  if ([options.init, options.check, options.dryRun].filter(Boolean).length > 1) {
    throw new Error('Use only one of --init, --check, or --dry-run.')
  }
  return options
}

async function completeOptionsInteractively(
  options: Options,
  prompt: PromptContext,
): Promise<Options> {
  const nextOptions: Options = {
    ...options,
    remoteUri: options.remoteUri ?? getConfiguredRemoteUri(),
    localUri: options.localUri ?? getConfiguredLocalUri(),
    localDb:
      options.localDb ??
      getConfiguredLocalDb() ??
      (options.skipMongo
        ? undefined
        : extractDatabaseName(options.localUri ?? getConfiguredLocalUri())) ??
      'development',
    s3Bucket: options.s3Bucket ?? getConfiguredS3Bucket(),
    s3Prefix: options.s3Prefix ?? getConfiguredS3Prefix(),
    rewriteMediaHost: options.rewriteMediaHost ?? getConfiguredRewriteMediaHost(),
    rewriteMediaDropFirstSegment:
      options.rewriteMediaDropFirstSegment || getConfiguredRewriteMediaDropFirstSegment(),
  }

  if (!options.skipMongo) {
    nextOptions.remoteUri = await prompt.ask('Remote MongoDB URI', nextOptions.remoteUri)

    const remoteDatabases = await listMongoDatabases(nextOptions.remoteUri)
    nextOptions.remoteDb = await prompt.choose(
      'Remote database to dump',
      remoteDatabases,
      options.remoteDb ?? getConfiguredRemoteDb() ?? extractDatabaseName(nextOptions.remoteUri),
    )

    nextOptions.localUri = await prompt.ask('Local MongoDB URI', nextOptions.localUri)

    const localDatabases = await listMongoDatabases(nextOptions.localUri)
    nextOptions.localDb = await prompt.choose(
      'Local database to restore into',
      localDatabases,
      options.localDb ??
        getConfiguredLocalDb() ??
        extractDatabaseName(nextOptions.localUri) ??
        'development',
    )
  }

  if (!options.skipS3) {
    const buckets = listS3Buckets()
    nextOptions.s3Bucket = await prompt.choose('S3 bucket to sync', buckets, nextOptions.s3Bucket)

    const prefixes = nextOptions.s3Bucket !== undefined ? listS3Prefixes(nextOptions.s3Bucket) : []
    nextOptions.s3Prefix = await prompt.choose(
      'S3 prefix to sync (/ means whole bucket)',
      ['/', ...prefixes],
      nextOptions.s3Prefix || '/',
      true,
    )
  }

  return nextOptions
}

function resolveOptions(options: Options): ResolvedOptions {
  const remoteUri = options.remoteUri ?? getConfiguredRemoteUri()
  const localUri = options.localUri ?? getConfiguredLocalUri()
  const remoteDb =
    options.remoteDb ??
    getConfiguredRemoteDb() ??
    (options.skipMongo ? undefined : extractDatabaseName(remoteUri))
  const localDb =
    options.localDb ??
    getConfiguredLocalDb() ??
    (options.skipMongo ? undefined : extractDatabaseName(localUri)) ??
    'development'

  const s3Bucket = options.s3Bucket ?? getConfiguredS3Bucket()
  const s3Prefix = normalizeS3Prefix(options.s3Prefix ?? getConfiguredS3Prefix())
  const rewriteMediaHost = options.rewriteMediaHost ?? getConfiguredRewriteMediaHost()
  const rewriteMediaDropFirstSegment =
    options.rewriteMediaDropFirstSegment || getConfiguredRewriteMediaDropFirstSegment()
  const s3Dest = path.resolve(repoRoot, './s3-bucket')

  if (!options.skipMongo) {
    if (!remoteUri) {
      throw new Error(
        'Remote MongoDB URI is required. Pass --remote-uri, set SYNC_REMOTE_MONGO_URI, or run interactively.',
      )
    }

    if (!remoteDb) {
      throw new Error(
        'Remote MongoDB database name is required. Pass --remote-db, set SYNC_REMOTE_MONGO_DB, or run interactively.',
      )
    }

    if (!localUri) {
      throw new Error(
        'Local MongoDB URI is required. Pass --local-uri, set SYNC_LOCAL_MONGO_URI, or run interactively.',
      )
    }
    validateMongoTargets(remoteUri, remoteDb, localUri, localDb)
  }

  if (!options.skipS3 && !s3Bucket) {
    throw new Error(
      'S3 bucket is required. Pass --s3-bucket, set SYNC_S3_BUCKET, or run interactively.',
    )
  }
  if (!options.skipS3 && s3Bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3Bucket)) {
    throw new Error('S3 bucket must be a bucket name, without a URL or prefix.')
  }

  return {
    ...options,
    localDb,
    localUri,
    remoteDb,
    remoteUri,
    rewriteMediaDropFirstSegment,
    rewriteMediaHost,
    s3Bucket,
    s3Dest,
    s3Prefix,
  }
}

async function runMongoSync(options: ResolvedOptions) {
  ensureCommandAvailable('mongodump')
  ensureCommandAvailable('mongorestore')

  if (!options.remoteUri || !options.remoteDb || !options.localUri || !options.localDb) {
    throw new Error('MongoDB sync requires remote/local URIs and database names.')
  }

  const tempBaseDir = options.tempDir ? path.resolve(repoRoot, options.tempDir) : os.tmpdir()
  mkdirSync(tempBaseDir, { recursive: true })

  const dumpRoot = mkdtempSync(path.join(tempBaseDir, 'sync-mongo-s3-'))
  const shouldCleanup = !options.keepDump
  const dumpOutputDir = path.join(dumpRoot, 'dump')

  mkdirSync(dumpOutputDir, { recursive: true })

  console.log(
    [
      `Mongo: dumping ${options.remoteDb} from ${redactMongoUri(options.remoteUri)}`,
      `restoring to ${options.localDb} on ${redactMongoUri(options.localUri)}`,
    ].join('\n'),
  )

  try {
    const remoteDumpUri = await prepareMongoToolUri(options.remoteUri, options.remoteDb)
    const localRestoreUri = await prepareMongoToolUri(options.localUri)
    runCommand('mongodump', buildMongoDumpArgs(remoteDumpUri, options.remoteDb, dumpOutputDir))
    runCommand(
      'mongorestore',
      buildMongoRestoreArgs(localRestoreUri, options.remoteDb, options.localDb, dumpOutputDir),
    )

    if (options.rewriteMediaHost) {
      await rewriteMediaUrlsForLocalDevelopment(
        options.localUri,
        options.localDb,
        options.rewriteMediaHost,
        options.rewriteMediaDropFirstSegment,
      )
    }
  } finally {
    if (shouldCleanup) {
      rmSync(dumpRoot, { force: true, recursive: true })
    } else {
      console.log(`Preserved MongoDB dump at ${dumpRoot}`)
    }
  }
}

function runS3Sync(options: ResolvedOptions) {
  if (!options.s3Bucket) {
    throw new Error('S3 sync requires a bucket name.')
  }

  const destination = options.s3Dest
  mkdirSync(destination, { recursive: true })

  const source = buildS3Source(options.s3Bucket, options.s3Prefix)
  const args = ['s3', 'sync', source, destination]

  const env = buildAwsEnv()

  console.log(`S3: syncing ${source} into ${destination}`)
  runCommand('aws', args, env)
}

function buildS3Source(bucket: string, prefix?: string) {
  return prefix ? `s3://${bucket}/${prefix}` : `s3://${bucket}`
}

function buildAwsEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' }
  const region = getConfiguredAwsRegion()

  if (region) {
    env.AWS_REGION = region
    env.AWS_DEFAULT_REGION = region
  }

  return env
}

function getConfiguredRemoteUri() {
  return getOptionalEnvValue(['SYNC_REMOTE_MONGO_URI', 'REMOTE_MONGODB_URI'])
}

function getConfiguredRemoteDb() {
  return getOptionalEnvValue(['SYNC_REMOTE_MONGO_DB', 'REMOTE_DATABASE_NAME'])
}

function getConfiguredLocalUri() {
  return getOptionalEnvValue(['SYNC_LOCAL_MONGO_URI', 'LOCAL_MONGODB_URI', 'DATABASE_URI'])
}

function getConfiguredLocalDb() {
  return getOptionalEnvValue([
    'SYNC_LOCAL_MONGO_DB',
    'LOCAL_DATABASE_NAME',
    'PAYLOAD_DB_NAME',
    'VERCEL_ENV',
  ])
}

function getConfiguredS3Bucket() {
  return getOptionalEnvValue(['SYNC_S3_BUCKET', 'S3_BUCKET'])
}

function getConfiguredS3Prefix() {
  return normalizeS3Prefix(getOptionalEnvValue(['SYNC_S3_PREFIX', 'S3_PREFIX']))
}

function getConfiguredAwsRegion() {
  return getOptionalEnvValue(['SYNC_AWS_REGION', 'AWS_REGION', 'S3_REGION'])
}

function getConfiguredRewriteMediaHost() {
  return getOptionalEnvValue(['SYNC_MEDIA_URL_REWRITE_HOST', 'MEDIA_URL_REWRITE_HOST'])
}

function getConfiguredRewriteMediaDropFirstSegment() {
  return getTruthyEnvValue([
    'SYNC_MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT',
    'MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT',
  ])
}

function getOptionalEnvValue(keys: string[]) {
  for (const key of keys) {
    const value = normalizeOptionalValue(process.env[key])
    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

function getTruthyEnvValue(keys: string[]) {
  for (const key of keys) {
    const value = normalizeOptionalValue(process.env[key])
    if (value !== undefined) return isTruthyEnv(value)
  }

  return false
}

function runPreflightChecks(options: Options) {
  if (!options.skipS3) {
    ensureCommandAvailable('aws')
  }

  if (!options.skipMongo) {
    ensureCommandAvailable('mongodump')
    ensureCommandAvailable('mongorestore')
  }
}

function ensureCommandAvailable(command: string) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assertCommandSucceeded(command, result)
}

function assertCommandSucceeded(command: string, result: SpawnSyncReturns<string | Buffer>) {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code

  if (errorCode === 'ENOENT') {
    throw new Error(`${command} is required but not installed or not on PATH.`)
  }
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`)
  if (result.signal) throw new Error(`${command} was terminated by ${result.signal}.`)
  if (result.status !== 0) {
    const details = result.stderr?.toString().trim()
    throw new Error(
      `${command} exited with code ${result.status ?? 'unknown'}.${details ? `\n${details}` : ''}`,
    )
  }
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  console.log(`$ ${formatCommandForLog(command, args)}`)

  const result = spawnSync(command, args, {
    env,
    stdio: 'inherit',
  })
  assertCommandSucceeded(command, result)
}

function runCommandForJson(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  assertCommandSucceeded(command, result)
  try {
    const parsed: unknown = JSON.parse(result.stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new Error(`${command} returned invalid JSON.`)
  }
}

async function listMongoDatabases(uri?: string) {
  if (!uri) {
    return []
  }

  try {
    return await listMongoDatabasesStrict(uri)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(redactErrorMessage(message))
    return []
  }
}

async function listMongoDatabasesStrict(uri: string) {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  })

  try {
    await client.connect()
    const response = await client.db('admin').admin().listDatabases()
    return response.databases
      .map((database) => database.name)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not list MongoDB databases for ${redactMongoUri(uri)}: ${message}`)
  } finally {
    await client.close()
  }
}

function listS3Buckets() {
  try {
    const output = runCommandForJson(
      'aws',
      ['s3api', 'list-buckets', '--output', 'json'],
      buildAwsEnv(),
    ) as { Buckets?: Array<{ Name?: string }> }
    return (output.Buckets ?? [])
      .map((bucket) => bucket.Name)
      .filter((name): name is string => typeof name === 'string' && Boolean(name))
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    console.warn(
      `Could not discover S3 buckets: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}

function listS3Prefixes(bucket: string) {
  const args = [
    's3api',
    'list-objects-v2',
    '--bucket',
    bucket,
    '--delimiter',
    '/',
    '--output',
    'json',
  ]

  try {
    const output = runCommandForJson('aws', args, buildAwsEnv()) as {
      CommonPrefixes?: Array<{ Prefix?: string }>
    }
    return (output.CommonPrefixes ?? [])
      .map((entry) => normalizeS3Prefix(entry.Prefix))
      .filter((prefix): prefix is string => Boolean(prefix))
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    console.warn(
      `Could not discover S3 prefixes: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}

function createPromptContext(): PromptContext {
  const rl = createInterface({ input, output })

  return {
    async ask(question, defaultValue) {
      const displayedDefault = defaultValue?.startsWith('mongodb')
        ? redactMongoUri(defaultValue)
        : defaultValue
      const suffix = displayedDefault ? ` [${displayedDefault}]` : ''
      const answer = (await rl.question(`${question}${suffix}: `)).trim()
      return answer || defaultValue || ''
    },
    async confirm(question, defaultValue = false) {
      const defaultLabel = defaultValue ? 'Y/n' : 'y/N'
      const answer = (await rl.question(`${question} [${defaultLabel}]: `)).trim().toLowerCase()

      if (!answer) {
        return defaultValue
      }

      return ['y', 'yes'].includes(answer)
    },
    async choose(question, choices, defaultValue, allowCustom = true) {
      const uniqueChoices = Array.from(new Set(choices.filter(Boolean)))

      if (uniqueChoices.length === 0) {
        return this.ask(question, defaultValue)
      }

      console.log(question)
      for (const [index, choice] of uniqueChoices.entries()) {
        const defaultMarker = choice === defaultValue ? ' (default)' : ''
        console.log(`  ${index + 1}. ${choice}${defaultMarker}`)
      }
      if (allowCustom) {
        console.log('  0. Enter a custom value')
      }

      while (true) {
        const answer = (
          await rl.question(`Select a number${defaultValue ? ` [${defaultValue}]` : ''}: `)
        ).trim()

        if (!answer) {
          return defaultValue ?? ''
        }

        if (allowCustom && answer === '0') {
          return this.ask(question, defaultValue)
        }

        const numeric = /^\d+$/.test(answer) ? Number(answer) : Number.NaN
        if (Number.isInteger(numeric) && numeric >= 1 && numeric <= uniqueChoices.length) {
          return uniqueChoices[numeric - 1]
        }

        if (allowCustom && answer) {
          return answer
        }

        console.log('Please choose one of the listed options.')
      }
    },
    close() {
      rl.close()
    },
  }
}

function formatCommandForLog(command: string, args: string[]) {
  return [
    command,
    ...args
      .map(redactCommandArgument)
      .map((arg) => (/^[\w./:=@+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)),
  ].join(' ')
}

function redactCommandArgument(argument: string) {
  if (argument.startsWith('--uri=')) {
    return '--uri=<redacted>'
  }

  return argument
}

function redactMongoUri(uri?: string) {
  if (!uri) {
    return '<unset>'
  }

  return uri
    .replace(/(mongodb(?:\+srv)?:\/\/)[^/?#]*@/u, '$1<redacted>@')
    .replace(/\?.*$/u, '?<redacted>')
}

function redactErrorMessage(message: string) {
  return message.replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gu, (uri) => redactMongoUri(uri))
}

function normalizeS3Prefix(prefix?: string) {
  if (!prefix) {
    return undefined
  }

  return prefix.replace(/^\/+|\/+$/gu, '')
}

function normalizeOptionalValue(value?: string) {
  const normalized = value?.trim()
  if (!normalized || normalized === '<REPLACE_ME>') {
    return undefined
  }

  return normalized
}

function isTruthyEnv(value?: string) {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}
