import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BSON, MongoClient } from 'mongodb'
import {
  collectMediaUrlUpdates,
  rewriteMediaUrl,
  rewriteMediaUrlsForLocalDevelopment,
} from '../dist/media.js'

const host = 'cdn.example.com'
const mediaUrl = `https://${host}/media/image.jpg`

test('rewrites only HTTP(S) URLs on the selected hostname', () => {
  assert.equal(rewriteMediaUrl(mediaUrl, host, false), '/s3-bucket/media/image.jpg')
  assert.equal(
    rewriteMediaUrl(`http://${host}:8080/image.jpg`, host.toUpperCase(), false),
    '/s3-bucket/image.jpg',
  )
  for (const value of [
    'plain text',
    '/media/image.jpg',
    `//${host}/media/image.jpg`,
    `ftp://${host}/media/image.jpg`,
    `file://${host}/media/image.jpg`,
    'https://other.example.com/image.jpg',
    `https://${host}.other.example.com/image.jpg`,
    `https://${host}/`,
  ]) {
    assert.equal(rewriteMediaUrl(value, host, false), value)
  }
})

test('preserves object-key slashes, escaped characters, queries, and fragments', () => {
  const value = `https://${host}/media//nested/a%2Fb%20c.jpg/?download=1#preview`
  assert.equal(
    rewriteMediaUrl(value, host, false),
    '/s3-bucket/media//nested/a%2Fb%20c.jpg/?download=1#preview',
  )
  assert.equal(
    rewriteMediaUrl(value, host, true),
    '/s3-bucket//nested/a%2Fb%20c.jpg/?download=1#preview',
  )
  assert.equal(rewriteMediaUrl(mediaUrl, host, true), '/s3-bucket/image.jpg')
  assert.equal(rewriteMediaUrl(`https://${host}/image.jpg`, host, true), '/s3-bucket/image.jpg')
})

test('rewrites nested fields and arrays without touching immutable document IDs', () => {
  const doc = {
    _id: { url: mediaUrl, nested: [mediaUrl] },
    url: mediaUrl,
    nested: { _id: mediaUrl, image: mediaUrl },
    gallery: [{ src: mediaUrl }, mediaUrl, null],
  }
  const original = structuredClone(doc)
  assert.deepEqual(
    { ...collectMediaUrlUpdates(doc, '', host, true) },
    {
      url: '/s3-bucket/image.jpg',
      'nested._id': '/s3-bucket/image.jpg',
      'nested.image': '/s3-bucket/image.jpg',
      'gallery.0.src': '/s3-bucket/image.jpg',
      'gallery.1': '/s3-bucket/image.jpg',
    },
  )
  assert.deepEqual(doc, original)
  assert.equal(Object.keys(collectMediaUrlUpdates(mediaUrl, '_id', host, true)).length, 0)
})

test('skips keys that would address another field or act as update operators', () => {
  const doc = {
    'image.url': mediaUrl,
    $url: mediaUrl,
    '': { image: mediaUrl },
    'bad\0key': mediaUrl,
    nested: { 'bad.key': { image: mediaUrl }, $bad: [mediaUrl], good: mediaUrl },
    image: { url: mediaUrl },
  }
  assert.deepEqual(
    { ...collectMediaUrlUpdates(doc, '', host, false) },
    {
      'nested.good': '/s3-bucket/media/image.jpg',
      'image.url': '/s3-bucket/media/image.jpg',
    },
  )
})

test('retains BSON values and their scopes while traversing ordinary document fields', () => {
  const doc = {
    _id: new BSON.ObjectId(),
    script: new BSON.Code(mediaUrl, { url: mediaUrl }),
    reference: new BSON.DBRef(mediaUrl, new BSON.ObjectId()),
    binary: new BSON.Binary(Buffer.from(mediaUrl)),
    number: BSON.Decimal128.fromString('1.5'),
    long: BSON.Long.fromString('9007199254740993'),
    timestamp: new BSON.Timestamp({ t: 1, i: 1 }),
    date: new Date('2026-01-01T00:00:00Z'),
    regex: new BSON.BSONRegExp(mediaUrl),
    image: { url: mediaUrl },
  }
  const serializedBefore = BSON.serialize(doc)
  assert.deepEqual(
    { ...collectMediaUrlUpdates(doc, '', host, true) },
    {
      'image.url': '/s3-bucket/image.jpg',
    },
  )
  assert.deepEqual(BSON.serialize(doc), serializedBefore)
  assert.deepEqual(
    { ...collectMediaUrlUpdates({ _bsontype: 'custom metadata', url: mediaUrl }, '', host, true) },
    { url: '/s3-bucket/image.jpg' },
  )
})

test('handles null-prototype documents and literal __proto__ fields safely', () => {
  const doc = Object.assign(Object.create(null), JSON.parse(`{"__proto__":"${mediaUrl}"}`))
  const updates = collectMediaUrlUpdates(doc, '', host, true)
  assert.equal(Object.getPrototypeOf(updates), null)
  assert.equal(Object.hasOwn(updates, '__proto__'), true)
  assert.equal(updates.__proto__, '/s3-bucket/image.jpg')
})

test('collects every URL in a large media array', () => {
  const gallery = Array.from({ length: 10_000 }, (_, i) => `https://${host}/image-${i}.jpg`)
  const updates = collectMediaUrlUpdates({ gallery }, '', host, false)
  assert.equal(Object.keys(updates).length, gallery.length)
  assert.equal(updates['gallery.0'], '/s3-bucket/image-0.jpg')
  assert.equal(updates['gallery.9999'], '/s3-bucket/image-9999.jpg')
})

test('rewriting scans only ordinary user collections and closes the client', async (t) => {
  const updated = []
  const opened = []
  const logged = []
  t.mock.method(MongoClient.prototype, 'connect', async function () {
    return this
  })
  const close = t.mock.method(MongoClient.prototype, 'close', async () => {})
  t.mock.method(console, 'log', (value) => logged.push(value))
  t.mock.method(MongoClient.prototype, 'db', (databaseName) => {
    assert.equal(databaseName, 'development')
    return {
      listCollections(filter, options) {
        assert.deepEqual(filter, { type: 'collection' })
        assert.deepEqual(options, { nameOnly: true })
        return {
          async toArray() {
            return [
              { name: 'media', type: 'collection' },
              { name: 'system.views', type: 'collection' },
              { name: 'mediaView', type: 'view' },
              { name: 'metrics', type: 'timeseries' },
            ]
          },
        }
      },
      collection(name) {
        opened.push(name)
        return {
          async *find() {
            yield { _id: mediaUrl, image: mediaUrl }
            yield { _id: 'unchanged', image: '/s3-bucket/image.jpg' }
            yield { _id: 'deleted', image: mediaUrl }
          },
          async updateOne(filter, update) {
            updated.push({ filter, update })
            return { modifiedCount: filter._id === 'deleted' ? 0 : 1 }
          },
        }
      },
    }
  })

  await rewriteMediaUrlsForLocalDevelopment('mongodb://localhost', 'development', host, true)

  assert.deepEqual(opened, ['media'])
  assert.equal(updated.length, 2)
  assert.deepEqual(updated[0].filter, { _id: mediaUrl })
  assert.deepEqual({ ...updated[0].update.$set }, { image: '/s3-bucket/image.jpg' })
  assert.equal(close.mock.callCount(), 1)
  assert.deepEqual(logged, [
    'Mongo: rewrote 1 media URL field(s) across 1 document(s) in development',
  ])
})

test('rewrite failures still close the MongoDB client', async (t) => {
  t.mock.method(MongoClient.prototype, 'connect', async function () {
    return this
  })
  const close = t.mock.method(MongoClient.prototype, 'close', async () => {})
  t.mock.method(MongoClient.prototype, 'db', () => {
    throw new Error('collection lookup failed')
  })
  await assert.rejects(
    rewriteMediaUrlsForLocalDevelopment('mongodb://localhost', 'development', host, false),
    /collection lookup failed/,
  )
  assert.equal(close.mock.callCount(), 1)
})
