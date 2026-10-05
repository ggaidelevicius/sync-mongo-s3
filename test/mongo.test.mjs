import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MongoClient } from 'mongodb'
import {
  buildMongoDumpArgs,
  buildMongoRestoreArgs,
  extractDatabaseName,
  prepareMongoToolUri,
  rewriteMongoUriDatabase,
  validateMongoTargets,
} from '../dist/mongo.js'

test('MongoDB URI rewriting accepts seed lists, IPv6, sockets, and encoded names', () => {
  for (const authority of ['db1:27017,db2:27018', '[::1]:27017', '%2Ftmp%2Fmongo.sock']) {
    const uri = `mongodb://user:pass@${authority}/original?replicaSet=rs0`
    const rewritten = rewriteMongoUriDatabase(uri, 'dévelopment')
    const options = new MongoClient(rewritten).options
    assert.equal(options.dbName, 'dévelopment')
    assert.equal(options.credentials.source, 'original')
    assert.equal(options.replicaSet, 'rs0')
    assert.equal(extractDatabaseName(rewritten), 'dévelopment')
  }
})

test('database extraction distinguishes absent database from the driver default', () => {
  assert.equal(extractDatabaseName(undefined), undefined)
  assert.equal(extractDatabaseName('mongodb://localhost'), undefined)
  assert.equal(extractDatabaseName('mongodb://localhost/?authSource=admin'), undefined)
  assert.equal(extractDatabaseName('mongodb://localhost/development'), 'development')
})

test('changing and removing the database preserves authentication and URI options', () => {
  for (const [uri, expectedSource] of [
    ['mongodb://user:p%40ss@localhost/', 'admin'],
    ['mongodb://user:p%40ss@localhost/original', 'original'],
    ['mongodb://user:p%40ss@localhost/original?authSource=other', 'other'],
    ['mongodb://user:p%40ss@localhost/original?AUTHSOURCE=other', 'other'],
  ]) {
    for (const database of ['development', undefined]) {
      const rewritten = rewriteMongoUriDatabase(uri, database)
      const options = new MongoClient(rewritten).options
      assert.equal(options.credentials.source, expectedSource)
      assert.equal(options.credentials.password, 'p@ss')
      assert.equal(extractDatabaseName(rewritten), database)
    }
  }
})

test('SRV authentication uses TXT authSource before changing or removing the database', async () => {
  const calls = []
  const lookup = async (hostname) => {
    calls.push(hostname)
    return [['replicaSet=rs0&auth', 'Source=admin']]
  }
  for (const database of ['development', undefined]) {
    const rewritten = await prepareMongoToolUri(
      'mongodb+srv://user:pass@cluster.example.com/original',
      database,
      lookup,
    )
    assert.equal(new MongoClient(rewritten).options.credentials.source, 'admin')
    assert.equal(extractDatabaseName(rewritten), database)
  }
  assert.deepEqual(calls, ['cluster.example.com', 'cluster.example.com'])
})

test('SRV authentication retains original default when TXT is absent', async () => {
  for (const code of ['ENODATA', 'ENOTFOUND']) {
    const rewritten = await prepareMongoToolUri(
      'mongodb+srv://user:pass@cluster.example.com/original',
      'development',
      async () => {
        throw Object.assign(new Error('No TXT'), { code })
      },
    )
    assert.equal(new MongoClient(rewritten).options.credentials.source, 'original')
  }
})

test('SRV lookup is skipped for explicit authSource, external auth, and standard URIs', async () => {
  for (const uri of [
    'mongodb+srv://user:pass@cluster.example.com/original?authSource=admin',
    'mongodb+srv://cluster.example.com/?authMechanism=MONGODB-X509',
    'mongodb://user:pass@localhost/original',
  ]) {
    await prepareMongoToolUri(uri, 'development', async () => {
      assert.fail('TXT lookup should not be needed')
    })
  }
})

test('SRV lookup failures and ambiguous TXT settings fail before restoring', async () => {
  const uri = 'mongodb+srv://user:pass@cluster.example.com/original'
  await assert.rejects(
    prepareMongoToolUri(uri, undefined, async () => {
      throw Object.assign(new Error('Timed out'), { code: 'ETIMEOUT' })
    }),
    /Could not resolve/,
  )
  for (const records of [[['authSource=one'], ['authSource=two']], [['authSource=']]]) {
    await assert.rejects(
      prepareMongoToolUri(uri, undefined, async () => records),
      /TXT|authSource/,
    )
  }
})

test('target validation refuses overlapping endpoints and loopback aliases for the same database', () => {
  for (const [source, destination] of [
    ['mongodb://db1,db2/', 'mongodb://db2,db3/'],
    ['mongodb://localhost/', 'mongodb://127.0.0.1:27017/'],
    ['mongodb://[::1]/', 'mongodb://localhost/'],
    ['mongodb://%2Ftmp%2Fmongo.sock/', 'mongodb://%2Ftmp%2Fmongo.sock/'],
    ['mongodb+srv://cluster.example.com/', 'mongodb+srv://cluster.example.com/'],
  ]) {
    assert.throws(
      () => validateMongoTargets(source, 'production', destination, 'Production'),
      /Refusing to restore onto the source/,
    )
  }
})

test('target validation permits distinct databases and independent endpoints', () => {
  validateMongoTargets('mongodb://localhost/', 'production', 'mongodb://localhost/', 'development')
  validateMongoTargets('mongodb://remote/', 'production', 'mongodb://localhost/', 'production')
  validateMongoTargets(
    'mongodb://localhost:27017/',
    'production',
    'mongodb://localhost:27018/',
    'production',
  )
})

test('target validation rejects internal, invalid, oversized, and wildcard database names', () => {
  for (const name of [
    'admin',
    'CONFIG',
    'local',
    '../prod',
    'prod.*',
    'bad$name',
    'a'.repeat(64),
    'é'.repeat(32),
    '',
  ]) {
    assert.throws(() =>
      validateMongoTargets('mongodb://remote/', 'production', 'mongodb://localhost/', name),
    )
  }
  assert.throws(() =>
    validateMongoTargets('mongodb://remote/', '*', 'mongodb://localhost/', 'development'),
  )
  assert.throws(
    () => extractDatabaseName('mongodb://user:secret@'),
    (error) => {
      assert.doesNotMatch(error.message, /secret/)
      return true
    },
  )
})

test('dump and restore arguments use source namespaces, a root dump directory, and stop on error', () => {
  assert.deepEqual(buildMongoDumpArgs('mongodb://remote/production', 'production', '/tmp/dump'), [
    '--uri=mongodb://remote/production',
    '--db=production',
    '--out=/tmp/dump',
  ])
  assert.deepEqual(
    buildMongoRestoreArgs('mongodb://localhost/', 'production', 'development', '/tmp/dump'),
    [
      '--uri=mongodb://localhost/',
      '--drop',
      '--stopOnError',
      '--nsInclude=production.*',
      '--nsFrom=production.*',
      '--nsTo=development.*',
      '/tmp/dump',
    ],
  )
})
