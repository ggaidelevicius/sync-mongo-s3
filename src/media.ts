import { MongoClient } from 'mongodb'

export async function rewriteMediaUrlsForLocalDevelopment(
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
      .listCollections({ type: 'collection' }, { nameOnly: true })
      .toArray()

    for (const collectionInfo of collections) {
      if (
        !collectionInfo.name ||
        collectionInfo.name.startsWith('system.') ||
        collectionInfo.type !== 'collection'
      ) {
        continue
      }

      const collection = db.collection(collectionInfo.name)
      const cursor = collection.find({})

      for await (const doc of cursor) {
        const updates = collectMediaUrlUpdates(doc, '', rewriteHost, dropFirstSegment)
        const fieldCount = Object.keys(updates).length
        if (fieldCount === 0) {
          continue
        }

        const result = await collection.updateOne({ _id: doc._id }, { $set: updates })
        if (result.modifiedCount > 0) {
          updatedDocumentCount += result.modifiedCount
          updatedFieldCount += fieldCount
        }
      }
    }

    console.log(
      `Mongo: rewrote ${updatedFieldCount} media URL field(s) across ${updatedDocumentCount} document(s) in ${databaseName}`,
    )
  } finally {
    await client.close()
  }
}

export function collectMediaUrlUpdates(
  value: unknown,
  currentPath = '',
  rewriteHost: string,
  dropFirstSegment: boolean,
): Record<string, string> {
  // A null prototype keeps legitimate fields such as __proto__ as own properties.
  const updates: Record<string, string> = Object.create(null)

  function visit(nestedValue: unknown, fieldPath: string) {
    if (fieldPath === '_id' || fieldPath.startsWith('_id.')) {
      return
    }

    if (typeof nestedValue === 'string') {
      const rewritten = rewriteMediaUrl(nestedValue, rewriteHost, dropFirstSegment)
      if (fieldPath && rewritten !== nestedValue) {
        updates[fieldPath] = rewritten
      }
      return
    }

    if (Array.isArray(nestedValue)) {
      for (let index = 0; index < nestedValue.length; index += 1) {
        visit(nestedValue[index], fieldPath ? `${fieldPath}.${index}` : `${index}`)
      }
      return
    }

    if (!isTraversableDocument(nestedValue)) {
      return
    }

    for (const [key, child] of Object.entries(nestedValue)) {
      // These keys cannot be addressed literally by MongoDB's dotted $set paths.
      if (!key || key.includes('.') || key.startsWith('$') || key.includes('\0')) {
        continue
      }
      visit(child, fieldPath ? `${fieldPath}.${key}` : key)
    }
  }

  visit(value, currentPath)
  return updates
}

export function rewriteMediaUrl(value: string, rewriteHost: string, dropFirstSegment: boolean) {
  try {
    const parsed = new URL(value)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.hostname !== rewriteHost.toLowerCase()
    ) {
      return value
    }

    let localPath = parsed.pathname.slice(1)
    if (!localPath || !localPath.split('/').some(Boolean)) {
      return value
    }

    // Keep repeated and trailing slashes: they can be part of an S3 object key.
    const firstSlash = localPath.indexOf('/')
    if (dropFirstSegment && firstSlash >= 0) {
      const remainingPath = localPath.slice(firstSlash + 1)
      if (remainingPath.split('/').some(Boolean)) {
        localPath = remainingPath
      }
    }

    return `/s3-bucket/${localPath}${parsed.search}${parsed.hash}`
  } catch {
    return value
  }
}

function isTraversableDocument(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
