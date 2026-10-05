import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const releaseMarkers = new Map([
  ['(release:patch)', 'patch'],
  ['(release:minor)', 'minor'],
  ['(release:major)', 'major'],
])

export function getReleaseBump(message) {
  const markers = message.match(/\(release[^)\r\n]*\)?/g) ?? []
  if (markers.length === 0) return undefined

  if (markers.length !== 1 || !releaseMarkers.has(markers[0])) {
    throw new Error('Use exactly one of: (release:patch), (release:minor), (release:major).')
  }

  return releaseMarkers.get(markers[0])
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const commitMsgFile = process.argv[2]
    if (!commitMsgFile) {
      throw new Error('Commit message validation requires a commit message file path.')
    }

    const bump = getReleaseBump(fs.readFileSync(commitMsgFile, 'utf8'))
    if (process.argv.includes('--release')) {
      if (!bump) throw new Error('A release commit must include a release marker.')
      console.log(bump)
    }
  } catch (error) {
    console.error(`[sync-mongo-s3] ${error.message}`)
    process.exitCode = 1
  }
}
