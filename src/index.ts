#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { MongoClient } from 'mongodb'

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
const envFilePriority = [
	'.env.local',
	'.env.development.local',
	'.env.development',
	'.env',
]
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
		loadEnvFiles(listEnvFiles())

		let options = parseArgs(process.argv.slice(2))

		if (options.help) {
			console.log(usage)
			return
		}

		const prompt = isInteractiveTty ? createPromptContext() : undefined

		try {
			const initResult = await ensureSyncEnvInitialized(prompt)
			if (
				initResult.status === 'written' ||
				initResult.status === 'cancelled'
			) {
				return
			}

			const unresolvedSyncEnvEntries = findUnresolvedSyncEnvEntries(
				scanSyncEnvFiles(),
			)
			if (unresolvedSyncEnvEntries.length > 0) {
				reportUnresolvedSyncEnvEntries(unresolvedSyncEnvEntries)
				process.exitCode = 1
				return
			}

			if (options.init) {
				console.log(
					'SYNC_* initialization is already present. No new placeholders were added.',
				)
				return
			}

			if (options.skipMongo && options.skipS3) {
				throw new Error(
					'Nothing to do: both --skip-mongo and --skip-s3 were provided.',
				)
			}

			runPreflightChecks(options)

			if (shouldPrompt(options)) {
				if (!prompt) {
					throw new Error(
						'Missing required sync configuration. Run interactively or set the SYNC_* environment variables first.',
					)
				}

				options = await completeOptionsInteractively(options, prompt)
			}
		} finally {
			prompt?.close()
		}

		if (options.check) {
			await runCheckMode(options)
			return
		}

		const resolvedOptions = resolveOptions(options)

		if (options.dryRun) {
			printDryRunPlan(resolvedOptions)
			return
		}

		if (!resolvedOptions.skipMongo) {
			await runMongoSync(resolvedOptions)
		}

		if (!resolvedOptions.skipS3) {
			runS3Sync(resolvedOptions)
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(message)
		process.exitCode = 1
	}
}

function shouldPrompt(options: Options) {
	if (!isInteractiveTty) {
		return false
	}

	if (options.check || options.init) {
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
			extractDatabaseName(remoteUri)
		const localDb =
			options.localDb ??
			getConfiguredLocalDb() ??
			extractDatabaseName(localUri) ??
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
	const discoveredFiles = readdirSync(repoRoot)
		.filter((name) => name === '.env' || name.startsWith('.env.'))
		.sort((left, right) => left.localeCompare(right))
	const prioritizedFiles = envFilePriority.filter((file) =>
		discoveredFiles.includes(file),
	)
	const remainingFiles = discoveredFiles.filter(
		(file) => !prioritizedFiles.includes(file),
	)

	return [...prioritizedFiles, ...remainingFiles]
}

function loadEnvFiles(files: string[]) {
	for (const file of files) {
		const fullPath = path.join(repoRoot, file)
		if (!existsSync(fullPath)) {
			continue
		}

		const envValues = parseEnvFile(readFileSync(fullPath, 'utf8'))
		for (const [key, value] of Object.entries(envValues)) {
			if (process.env[key] === undefined) {
				process.env[key] = value
			}
		}
	}
}

function parseEnvFile(content: string) {
	const parsed: Record<string, string> = {}

	for (const { key, value } of parseEnvAssignments(content)) {
		const normalizedValue = normalizeOptionalValue(value)
		if (normalizedValue !== undefined) {
			parsed[key] = normalizedValue
		}
	}

	return parsed
}

function parseEnvAssignments(content: string) {
	const assignments: Array<{ key: string; value: string }> = []

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) {
			continue
		}

		const separatorIndex = line.indexOf('=')
		if (separatorIndex === -1) {
			continue
		}

		let key = line.slice(0, separatorIndex).trim()
		if (key.startsWith('export ')) {
			key = key.slice('export '.length).trim()
		}

		if (!key) {
			continue
		}

		let value = line.slice(separatorIndex + 1).trim()
		const quote = value.at(0)
		if (
			(quote === '"' || quote === "'") &&
			value.length >= 2 &&
			value.at(-1) === quote
		) {
			value = value.slice(1, -1)
		}

		assignments.push({ key, value })
	}

	return assignments
}

function scanSyncEnvFiles(): SyncEnvScanResult {
	const envFiles = listEnvFiles()
	const assignments: SyncEnvAssignment[] = []

	for (const file of envFiles) {
		const fullPath = path.join(repoRoot, file)
		if (!existsSync(fullPath)) {
			continue
		}

		for (const assignment of parseEnvAssignments(readFileSync(fullPath, 'utf8'))) {
			assignments.push({ file, ...assignment })
		}
	}

	return { assignments, envFiles }
}

function findMissingSyncEnvEntries(scan: SyncEnvScanResult) {
	return syncEnvTemplateEntries.filter(
		(entry) => !scan.assignments.some((assignment) => assignment.key === entry.key),
	)
}

function findUnresolvedSyncEnvEntries(scan: SyncEnvScanResult) {
	return syncEnvTemplateEntries
		.map((entry) => {
			const assignments = scan.assignments.filter(
				(assignment) => assignment.key === entry.key,
			)
			const hasConfiguredValue = assignments.some(
				(assignment) => normalizeOptionalValue(assignment.value) !== undefined,
			)
			if (hasConfiguredValue) {
				return undefined
			}

			return {
				file:
					assignments[0]?.file ?? selectEnvTargetFile(scan.envFiles),
				key: entry.key,
			}
		})
		.filter((entry): entry is { file: string; key: string } => entry !== undefined)
}

async function ensureSyncEnvInitialized(prompt?: PromptContext) {
	const scan = scanSyncEnvFiles()
	const missingEntries = findMissingSyncEnvEntries(scan)
	const targetFile = selectEnvTargetFile(scan.envFiles)

	if (missingEntries.length === 0) {
		return { scan, status: 'not_needed' as const, targetFile }
	}

	if (!prompt) {
		throw new Error(
			[
				'Missing initial SYNC_* environment keys.',
				`Run sync-mongo-s3 --init in an interactive terminal to scaffold placeholders in ${targetFile}.`,
			].join('\n'),
		)
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

	const shouldWrite = await prompt.confirm(
		`Write these placeholder keys to ${targetFile}?`,
		true,
	)
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
	const existingContent = existsSync(fullPath)
		? readFileSync(fullPath, 'utf8')
		: ''

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

	appendFileSync(fullPath, block, 'utf8')
}

function reportUnresolvedSyncEnvEntries(
	entries: Array<{ file: string; key: string }>,
) {
	console.error(
		[
			'The minimum SYNC_* setup exists but still contains empty placeholder values.',
			...entries.map(
				(entry) => `  ${entry.key} is still empty in ${entry.file}`,
			),
			'',
			'Fill these in with your own connection details before running sync-mongo-s3.',
		].join('\n'),
	)
}

async function runCheckMode(options: Options) {
	const lines = ['Running sync-mongo-s3 checks...']
	const failures: string[] = []

	if (!options.skipMongo) {
		const remoteUri = options.remoteUri ?? getConfiguredRemoteUri()
		const localUri = options.localUri ?? getConfiguredLocalUri()

		if (!remoteUri) {
			throw new Error('Missing SYNC_REMOTE_MONGO_URI for --check.')
		}

		if (!localUri) {
			throw new Error('Missing SYNC_LOCAL_MONGO_URI for --check.')
		}

		const remoteDatabases = await listMongoDatabasesStrict(remoteUri)
		const localDatabases = await listMongoDatabasesStrict(localUri)
		const remoteDb =
			options.remoteDb ??
			getConfiguredRemoteDb() ??
			extractDatabaseName(remoteUri)
		const localDb =
			options.localDb ??
			getConfiguredLocalDb() ??
			extractDatabaseName(localUri) ??
			'development'

		lines.push(
			`Mongo remote URI: OK (${redactMongoUri(remoteUri)})`,
			`Mongo remote DB discovery: OK (${remoteDatabases.length} database(s) visible)`,
			`Mongo local URI: OK (${redactMongoUri(localUri)})`,
			`Mongo local DB discovery: OK (${localDatabases.length} database(s) visible)`,
		)

		if (remoteDb) {
			const remoteDbExists = remoteDatabases.includes(remoteDb)
			lines.push(
				remoteDbExists
					? `Mongo remote DB target: OK (${remoteDb})`
					: `Mongo remote DB target: not found in discovery (${remoteDb})`,
			)
			if (!remoteDbExists) {
				failures.push(`Remote MongoDB database was not found: ${remoteDb}`)
			}
		}

		if (localDb) {
			const localDbExists = localDatabases.includes(localDb)
			lines.push(
				localDbExists
					? `Mongo local DB target: OK (${localDb})`
					: `Mongo local DB target: not found in discovery (${localDb})`,
			)
			if (!localDbExists) {
				failures.push(`Local MongoDB database was not found: ${localDb}`)
			}
		}
	}

	if (!options.skipS3) {
		ensureAwsAuthenticated()

		const buckets = listS3BucketsStrict()
		const bucket = options.s3Bucket ?? getConfiguredS3Bucket()
		lines.push(`AWS auth: OK (${buckets.length} bucket(s) visible)`)

		if (bucket) {
			const bucketExists = buckets.includes(bucket)
			lines.push(
				bucketExists
					? `S3 bucket target: OK (${bucket})`
					: `S3 bucket target: not found in discovery (${bucket})`,
			)
			if (!bucketExists) {
				failures.push(`S3 bucket was not found: ${bucket}`)
			}
		}
	}

	if (failures.length > 0) {
		throw new Error([...lines, '', ...failures].join('\n'))
	}

	console.log(lines.join('\n'))
}

function printDryRunPlan(options: ResolvedOptions) {
	const lines = [
		'Dry run only. No changes were made.',
		'',
		'Resolved plan:',
	]

	if (!options.skipMongo && options.remoteUri && options.remoteDb && options.localUri) {
		lines.push(
			`  Mongo source: ${options.remoteDb} on ${redactMongoUri(options.remoteUri)}`,
			`  Mongo target: ${options.localDb} on ${redactMongoUri(options.localUri)}`,
		)

		const remoteDumpUri = rewriteMongoUriDatabase(
			options.remoteUri,
			options.remoteDb,
		)
		const localRestoreUri = rewriteMongoUriDatabase(
			options.localUri,
			options.localDb ?? 'development',
		)

		lines.push(
			'',
			'Mongo commands:',
			`  $ ${formatCommandForLog('mongodump', [
				`--uri=${remoteDumpUri}`,
				`--db=${options.remoteDb}`,
				'--out=<temp dump dir>',
			])}`,
			`  $ ${formatCommandForLog('mongorestore', [
				`--uri=${localRestoreUri}`,
				'--drop',
				`--nsInclude=${options.remoteDb}.*`,
				`--nsFrom=${options.remoteDb}.*`,
				`--nsTo=${options.localDb}.*`,
				'<temp dump dir>/<remote db>',
			])}`,
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
		const flag =
			separatorIndex === -1 ? argument : argument.slice(0, separatorIndex)
		const inlineValue =
			separatorIndex === -1 ? undefined : argument.slice(separatorIndex + 1)
		const value = inlineValue ?? argv[index + 1]
		if (!value || value.startsWith('--')) {
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
			'development',
		s3Bucket: options.s3Bucket ?? getConfiguredS3Bucket(),
		s3Prefix: normalizeS3Prefix(options.s3Prefix ?? getConfiguredS3Prefix()),
		rewriteMediaHost:
			options.rewriteMediaHost ?? getConfiguredRewriteMediaHost(),
		rewriteMediaDropFirstSegment:
			options.rewriteMediaDropFirstSegment ||
			getConfiguredRewriteMediaDropFirstSegment(),
	}

	if (!options.skipMongo) {
		nextOptions.remoteUri = await prompt.ask(
			'Remote MongoDB URI',
			nextOptions.remoteUri,
		)

		const remoteDatabases = await listMongoDatabases(nextOptions.remoteUri)
		nextOptions.remoteDb = await prompt.choose(
			'Remote database to dump',
			remoteDatabases,
			options.remoteDb ??
				getConfiguredRemoteDb() ??
				extractDatabaseName(nextOptions.remoteUri),
		)

		nextOptions.localUri = await prompt.ask(
			'Local MongoDB URI',
			nextOptions.localUri,
		)

		const localDatabases = await listMongoDatabases(nextOptions.localUri)
		nextOptions.localDb = await prompt.choose(
			'Local database to restore into',
			localDatabases,
			nextOptions.localDb,
		)
	}

	if (!options.skipS3) {
		ensureAwsAuthenticated()

		const buckets = listS3Buckets()
		nextOptions.s3Bucket = await prompt.choose(
			'S3 bucket to sync',
			buckets,
			nextOptions.s3Bucket,
		)

		const prefixes =
			nextOptions.s3Bucket !== undefined
				? listS3Prefixes(nextOptions.s3Bucket)
				: []
		nextOptions.s3Prefix = normalizeS3Prefix(
			await prompt.choose(
				'S3 prefix to sync (blank means whole bucket)',
				prefixes,
				nextOptions.s3Prefix,
				true,
			),
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
		extractDatabaseName(remoteUri)
	const localDb =
		options.localDb ??
		getConfiguredLocalDb() ??
		extractDatabaseName(localUri) ??
		'development'

	const s3Bucket = options.s3Bucket ?? getConfiguredS3Bucket()
	const s3Prefix = normalizeS3Prefix(options.s3Prefix ?? getConfiguredS3Prefix())
	const rewriteMediaHost =
		options.rewriteMediaHost ?? getConfiguredRewriteMediaHost()
	const rewriteMediaDropFirstSegment =
		options.rewriteMediaDropFirstSegment ||
		getConfiguredRewriteMediaDropFirstSegment()
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
	}

	if (!options.skipS3 && !s3Bucket) {
		throw new Error(
			'S3 bucket is required. Pass --s3-bucket, set SYNC_S3_BUCKET, or run interactively.',
		)
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

	if (
		!options.remoteUri ||
		!options.remoteDb ||
		!options.localUri ||
		!options.localDb
	) {
		throw new Error(
			'MongoDB sync requires remote/local URIs and database names.',
		)
	}

	const tempBaseDir = options.tempDir
		? path.resolve(repoRoot, options.tempDir)
		: os.tmpdir()
	mkdirSync(tempBaseDir, { recursive: true })

	const dumpRoot = mkdtempSync(path.join(tempBaseDir, 'sync-mongo-s3-'))
	const shouldCleanup = !options.keepDump
	const dumpOutputDir = path.join(dumpRoot, 'dump')
	const dumpDatabaseDir = path.join(dumpOutputDir, options.remoteDb)

	mkdirSync(dumpOutputDir, { recursive: true })

	console.log(
		[
			`Mongo: dumping ${options.remoteDb} from ${redactMongoUri(options.remoteUri)}`,
			`restoring to ${options.localDb} on ${redactMongoUri(options.localUri)}`,
		].join('\n'),
	)

	try {
		const remoteDumpUri = rewriteMongoUriDatabase(
			options.remoteUri,
			options.remoteDb,
		)
		const localRestoreUri = rewriteMongoUriDatabase(
			options.localUri,
			options.localDb,
		)

		runCommand('mongodump', [
			`--uri=${remoteDumpUri}`,
			`--db=${options.remoteDb}`,
			`--out=${dumpOutputDir}`,
		])

		runCommand('mongorestore', [
			`--uri=${localRestoreUri}`,
			'--drop',
			`--nsInclude=${options.remoteDb}.*`,
			`--nsFrom=${options.remoteDb}.*`,
			`--nsTo=${options.localDb}.*`,
			dumpDatabaseDir,
		])

		if (options.rewriteMediaHost) {
			await rewriteMediaUrlsForLocalDevelopment(
				localRestoreUri,
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

	ensureAwsAuthenticated()

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
	const env = { ...process.env }
	const region = getConfiguredAwsRegion()

	if (region) {
		env.AWS_REGION = region
		env.AWS_DEFAULT_REGION = env.AWS_DEFAULT_REGION ?? region
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
	return getOptionalEnvValue([
		'SYNC_LOCAL_MONGO_URI',
		'LOCAL_MONGODB_URI',
		'DATABASE_URI',
	])
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
	return getOptionalEnvValue([
		'SYNC_MEDIA_URL_REWRITE_HOST',
		'MEDIA_URL_REWRITE_HOST',
	])
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
		if (isTruthyEnv(process.env[key])) {
			return true
		}
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
	})
	const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code

	if (errorCode === 'ENOENT') {
		throw new Error(`${command} is required but not installed or not on PATH.`)
	}
}

function ensureAwsAuthenticated() {
	const args = ['sts', 'get-caller-identity', '--output', 'json']
	const env = buildAwsEnv()
	const result = spawnSync('aws', args, {
		encoding: 'utf8',
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code

	if (errorCode === 'ENOENT') {
		throw new Error('aws is required but not installed or not on PATH.')
	}

	if (result.status === 0) {
		return
	}

	const stderr = result.stderr.trim()
	const authHint = 'Run aws login and try again.'

	throw new Error(
		stderr ? `AWS CLI is not authenticated. ${authHint}\n${stderr}` : authHint,
	)
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv) {
	console.log(`$ ${formatCommandForLog(command, args)}`)

	const result = spawnSync(command, args, {
		env,
		stdio: 'inherit',
	})
	const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code

	if (errorCode === 'ENOENT') {
		throw new Error(`${command} is required but not installed or not on PATH.`)
	}

	if (result.status !== 0) {
		throw new Error(
			`${command} exited with code ${result.status ?? 'unknown'}.`,
		)
	}
}

function runCommandForJson(
	command: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code

	if (errorCode === 'ENOENT') {
		return undefined
	}

	if (result.status !== 0) {
		return undefined
	}

	const stdout = result.stdout.trim()
	if (!stdout) {
		return undefined
	}

	return JSON.parse(stdout) as unknown
}

async function listMongoDatabases(uri?: string) {
	if (!uri) {
		return []
	}

	try {
		const client = new MongoClient(uri)
		await client.connect()
		try {
			const response = await client.db('admin').admin().listDatabases()
			return response.databases
				.map((database) => database.name)
				.filter(Boolean)
				.sort((left, right) => left.localeCompare(right))
		} finally {
			await client.close()
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.warn(
			`Could not list MongoDB databases for ${redactMongoUri(uri)}: ${message}`,
		)
		return []
	}
}

async function listMongoDatabasesStrict(uri: string) {
	const client = new MongoClient(uri)

	try {
		await client.connect()
		const response = await client.db('admin').admin().listDatabases()
		return response.databases
			.map((database) => database.name)
			.filter(Boolean)
			.sort((left, right) => left.localeCompare(right))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(
			`Could not list MongoDB databases for ${redactMongoUri(uri)}: ${message}`,
		)
	} finally {
		await client.close()
	}
}

function listS3Buckets() {
	const args = ['s3api', 'list-buckets', '--output', 'json']

	const output = runCommandForJson('aws', args, buildAwsEnv()) as
		| { Buckets?: Array<{ Name?: string }> }
		| undefined

	return (output?.Buckets ?? [])
		.map((bucket) => bucket.Name)
		.filter((name): name is string => Boolean(name))
		.sort((left, right) => left.localeCompare(right))
}

function listS3BucketsStrict() {
	const args = ['s3api', 'list-buckets', '--output', 'json']
	const output = runCommandForJson('aws', args, buildAwsEnv()) as
		| { Buckets?: Array<{ Name?: string }> }
		| undefined

	if (!output) {
		throw new Error('Could not list S3 buckets with the current AWS CLI setup.')
	}

	return (output.Buckets ?? [])
		.map((bucket) => bucket.Name)
		.filter((name): name is string => Boolean(name))
		.sort((left, right) => left.localeCompare(right))
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

	const output = runCommandForJson('aws', args, buildAwsEnv()) as
		| { CommonPrefixes?: Array<{ Prefix?: string }> }
		| undefined

	return (output?.CommonPrefixes ?? [])
		.map((entry) => normalizeS3Prefix(entry.Prefix))
		.filter((prefix): prefix is string => Boolean(prefix))
		.sort((left, right) => left.localeCompare(right))
}

function createPromptContext(): PromptContext {
	const rl = createInterface({ input, output })

	return {
		async ask(question, defaultValue) {
			const suffix = defaultValue ? ` [${defaultValue}]` : ''
			const answer = (await rl.question(`${question}${suffix}: `)).trim()
			return answer || defaultValue || ''
		},
		async confirm(question, defaultValue = false) {
			const defaultLabel = defaultValue ? 'Y/n' : 'y/N'
			const answer = (await rl.question(`${question} [${defaultLabel}]: `))
				.trim()
				.toLowerCase()

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
					await rl.question(
						`Select a number${defaultValue ? ` [${defaultValue}]` : ''}: `,
					)
				).trim()

				if (!answer && defaultValue) {
					return defaultValue
				}

				if (allowCustom && answer === '0') {
					return this.ask(question, defaultValue)
				}

				const numeric = Number.parseInt(answer, 10)
				if (
					Number.isInteger(numeric) &&
					numeric >= 1 &&
					numeric <= uniqueChoices.length
				) {
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
	return [command, ...args.map(redactCommandArgument)].join(' ')
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

	return uri.replace(/\/\/([^:/?#]+):([^@/?#]+)@/u, '//$1:<redacted>@')
}

function extractDatabaseName(uri?: string) {
	if (!uri) {
		return undefined
	}

	const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/u)
	if (!match) {
		return undefined
	}

	const databaseName = decodeURIComponent(match[1]).trim()
	return databaseName || undefined
}

function rewriteMongoUriDatabase(uri: string, databaseName: string) {
	const parsed = new URL(uri)
	parsed.pathname = `/${encodeURIComponent(databaseName)}`
	return parsed.toString()
}

async function rewriteMediaUrlsForLocalDevelopment(
	localUri: string,
	databaseName: string,
	rewriteHost: string,
	dropFirstSegment: boolean,
) {
	const client = new MongoClient(localUri)
	let updatedDocumentCount = 0
	let updatedFieldCount = 0

	try {
		await client.connect()

		const db = client.db(databaseName)
		const collections = await db
			.listCollections({}, { nameOnly: true })
			.toArray()

		for (const collectionInfo of collections) {
			if (!collectionInfo.name) {
				continue
			}

			const collection = db.collection(collectionInfo.name)
			const cursor = collection.find({})

			for await (const doc of cursor) {
				const updates = collectMediaUrlUpdates(
					doc,
					'',
					rewriteHost,
					dropFirstSegment,
				)
				const updateEntries = Object.entries(updates)

				if (updateEntries.length === 0) {
					continue
				}

				await collection.updateOne({ _id: doc._id }, { $set: updates })
				updatedDocumentCount += 1
				updatedFieldCount += updateEntries.length
			}
		}

		console.log(
			`Mongo: rewrote ${updatedFieldCount} media URL field(s) across ${updatedDocumentCount} document(s) in ${databaseName}`,
		)
	} finally {
		await client.close()
	}
}

function collectMediaUrlUpdates(
	value: unknown,
	currentPath = '',
	rewriteHost: string,
	dropFirstSegment: boolean,
): Record<string, string> {
	if (typeof value === 'string') {
		const rewritten = rewriteMediaUrl(value, rewriteHost, dropFirstSegment)
		if (rewritten !== value && currentPath) {
			return { [currentPath]: rewritten }
		}

		return {}
	}

	if (Array.isArray(value)) {
		return value.reduce<Record<string, string>>((acc, item, index) => {
			const nextPath = currentPath ? `${currentPath}.${index}` : `${index}`
			return {
				...acc,
				...collectMediaUrlUpdates(
					item,
					nextPath,
					rewriteHost,
					dropFirstSegment,
				),
			}
		}, {})
	}

	if (!isTraversableDocument(value)) {
		return {}
	}

	return Object.entries(value).reduce<Record<string, string>>(
		(acc, [key, nestedValue]) => {
			const nextPath = currentPath ? `${currentPath}.${key}` : key
			return {
				...acc,
				...collectMediaUrlUpdates(
					nestedValue,
					nextPath,
					rewriteHost,
					dropFirstSegment,
				),
			}
		},
		{},
	)
}

function rewriteMediaUrl(
	value: string,
	rewriteHost: string,
	dropFirstSegment: boolean,
) {
	try {
		const parsed = new URL(value)
		if (parsed.hostname !== rewriteHost) {
			return value
		}

		const pathSegments = parsed.pathname
			.split('/')
			.filter((segment) => segment.length > 0)
		if (pathSegments.length === 0) {
			return value
		}

		const localPathSegments =
			dropFirstSegment && pathSegments.length > 1
				? pathSegments.slice(1)
				: pathSegments
		const localPath = localPathSegments.join('/')
		const rewrittenPath = `/s3-bucket/${localPath}`
		return `${rewrittenPath}${parsed.search}${parsed.hash}`
	} catch {
		return value
	}
}

function isTraversableDocument(
	value: unknown,
): value is Record<string, unknown> {
	if (!value || typeof value !== 'object') {
		return false
	}

	if ('_bsontype' in value) {
		return false
	}

	return Object.getPrototypeOf(value) === Object.prototype
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
