import { MongoClient } from 'mongodb'
import { Resolver } from 'node:dns/promises'

function parseMongoUri(uri: string) {
  try {
    // The driver understands seed lists, IPv6 addresses, and Unix sockets;
    // WHATWG URL does not support every valid MongoDB authority.
    const options = new MongoClient(uri).options
    const parts = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/u)
    if (!parts) {
      throw new Error('Invalid URI format')
    }

    return {
      authority: parts[1],
      databaseName: parts[2] ? options.dbName : undefined,
      options,
      query: new URLSearchParams(parts[3]),
    }
  } catch {
    // Driver parse errors may contain the supplied URI or option values.
    throw new Error('Invalid MongoDB connection URI. Check its format and options.')
  }
}

export function extractDatabaseName(uri?: string) {
  return uri ? parseMongoUri(uri).databaseName : undefined
}

function hasAuthSource(query: URLSearchParams) {
  return [...query.keys()].some((key) => key.toLowerCase() === 'authsource')
}

export function rewriteMongoUriDatabase(uri: string, databaseName?: string) {
  const parsed = parseMongoUri(uri)
  if (databaseName !== undefined) {
    validateDatabaseName(databaseName)
  }

  if (!hasAuthSource(parsed.query) && parsed.options.credentials) {
    parsed.query.set('authSource', parsed.options.credentials.source)
  }

  const query = parsed.query.toString()
  return `${parsed.authority}/${databaseName ? encodeURIComponent(databaseName) : ''}${query ? `?${query}` : ''}`
}

export async function prepareMongoToolUri(
  uri: string,
  databaseName?: string,
  lookupTxt: (hostname: string) => Promise<string[][]> = async (hostname) => {
    const resolver = new Resolver({ timeout: 5_000, tries: 1 })
    return resolver.resolveTxt(hostname)
  },
) {
  const parsed = parseMongoUri(uri)
  const { credentials, srvHost } = parsed.options

  if (
    srvHost &&
    credentials &&
    credentials.source !== '$external' &&
    !hasAuthSource(parsed.query)
  ) {
    let records: string[][]
    try {
      records = await lookupTxt(srvHost)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
        throw new Error('Could not resolve MongoDB SRV authentication settings.')
      }
      records = []
    }

    if (records.length > 1) {
      throw new Error('MongoDB SRV host has multiple TXT records.')
    }
    const settings = new URLSearchParams(records[0]?.join(''))
    const sources = [...settings.entries()].filter(([key]) => key.toLowerCase() === 'authsource')
    if (sources.length > 1 || sources.some(([, value]) => !value)) {
      throw new Error('MongoDB SRV host has invalid authSource settings.')
    }
    parsed.query.set('authSource', sources[0]?.[1] ?? credentials.source)
    const query = parsed.query.toString()
    const originalDatabase = parsed.databaseName ? encodeURIComponent(parsed.databaseName) : ''
    uri = `${parsed.authority}/${originalDatabase}?${query}`
  }

  return rewriteMongoUriDatabase(uri, databaseName)
}

function validateDatabaseName(databaseName: string) {
  if (
    !databaseName ||
    Buffer.byteLength(databaseName, 'utf8') >= 64 ||
    /[\s/\\.\x00"$*<>:|?]/u.test(databaseName)
  ) {
    throw new Error(
      'Invalid MongoDB database name. Use fewer than 64 UTF-8 bytes, without whitespace, path separators, or namespace pattern characters.',
    )
  }
}

function normalizeHost(host: string) {
  const normalized = host.toLowerCase().replace(/\.$/u, '')
  if (
    normalized === 'localhost' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  ) {
    return 'loopback'
  }
  return normalized
}

function mongoEndpoints(uri: string) {
  const { options } = parseMongoUri(uri)
  const endpoints = options.hosts.map((address) =>
    address.socketPath
      ? `socket:${address.socketPath}`
      : `${normalizeHost(address.host ?? address.toString())}:${address.port}`,
  )
  if (options.srvHost) {
    endpoints.push(`srv:${normalizeHost(options.srvHost)}`)
  }
  return endpoints
}

export function validateMongoTargets(
  remoteUri: string,
  remoteDb: string,
  localUri: string,
  localDb: string,
) {
  validateDatabaseName(remoteDb)
  validateDatabaseName(localDb)
  if (['admin', 'config', 'local'].includes(localDb.toLowerCase())) {
    throw new Error('Refusing to restore into an internal MongoDB database.')
  }

  const remoteEndpoints = new Set(mongoEndpoints(remoteUri))
  const localEndpoints = mongoEndpoints(localUri)
  if (
    remoteDb.toLowerCase() === localDb.toLowerCase() &&
    localEndpoints.some((endpoint) => remoteEndpoints.has(endpoint))
  ) {
    throw new Error(
      'Refusing to restore onto the source MongoDB database. Choose a different destination database or server.',
    )
  }
}

export function buildMongoDumpArgs(uri: string, databaseName: string, dumpDirectory: string) {
  validateDatabaseName(databaseName)
  return [`--uri=${uri}`, `--db=${databaseName}`, `--out=${dumpDirectory}`]
}

export function buildMongoRestoreArgs(
  uri: string,
  remoteDb: string,
  localDb: string,
  dumpDirectory: string,
) {
  validateDatabaseName(remoteDb)
  validateDatabaseName(localDb)
  return [
    `--uri=${uri}`,
    '--drop',
    '--stopOnError',
    `--nsInclude=${remoteDb}.*`,
    `--nsFrom=${remoteDb}.*`,
    `--nsTo=${localDb}.*`,
    dumpDirectory,
  ]
}
