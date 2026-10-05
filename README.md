# @ggaidelevicius/sync-mongo-s3

A CLI for pulling your remote production environment down to local. It dumps a remote MongoDB database and restores it locally, and syncs an S3 bucket (or prefix) into `./s3-bucket` — all in one command.

Useful when you want to develop against real data without manually wrangling `mongodump`, `mongorestore`, and the AWS CLI every time.

## Requirements

- Node `>=20.19.0`
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) installed and authenticated
- [MongoDB Database Tools](https://www.mongodb.com/docs/database-tools/installation/installation/) installed (`mongodump`, `mongorestore`)

## Install

```bash
pnpm add -D @ggaidelevicius/sync-mongo-s3
```

or run without installing:

```bash
pnpm dlx @ggaidelevicius/sync-mongo-s3 --help
# or
npx @ggaidelevicius/sync-mongo-s3 --help
```

## Quick start

1. Add your connection URIs to your `.env` file (or let `--init` scaffold them):

```bash
SYNC_REMOTE_MONGO_URI=mongodb+srv://user:pass@cluster.example.com/
SYNC_LOCAL_MONGO_URI=mongodb://127.0.0.1/
```

2. Run the CLI — it will prompt for anything else it needs:

```bash
sync-mongo-s3
```

That's it. The CLI discovers available databases and S3 buckets interactively, so you don't need to configure everything upfront.

## Usage

```bash
sync-mongo-s3
```

When values are missing, the CLI prompts interactively and tries to list:

- remote Mongo databases
- local Mongo databases
- available S3 buckets
- top-level S3 prefixes

Connection settings can come from flags, exported environment variables, or development env files. No env file is required. Flags take precedence over the environment; existing environment values take precedence over files. Files are loaded in this order: `.env.local`, `.env.development.local`, `.env.development`, and `.env`. An empty value also takes precedence over lower-priority files. Production, test, and example env files are not loaded automatically. Quoted values, `export`, and inline comments follow [Node's dotenv syntax](https://nodejs.org/api/environment_variables.html#dotenv).

When a normal interactive MongoDB sync is missing connection settings, the CLI can offer to add missing URI placeholders to the highest-priority existing env file, or `.env.local` if none exists. It then stops so you can fill them in. Explicit `--init` writes missing placeholders without prompting, including outside a terminal, and leaves existing values intact. `--check` and `--dry-run` never scaffold files or prompt.

### Flags

- `--init` — scaffold the minimum `SYNC_*` placeholders into your env file
- `--check` — validate config, tooling, MongoDB discovery, and access to the selected S3 bucket/prefix without syncing; a new local database is allowed
- `--dry-run` — print the resolved sync plan and commands without contacting services or requiring external tools
- `--skip-s3` — skip the S3 sync, only run the Mongo dump/restore
- `--skip-mongo` — skip the Mongo dump/restore, only run the S3 sync; MongoDB settings are not required
- `--interactive` — prompt even when settings are already configured
- `--keep-dump` — retain the temporary dump after success or failure
- `--temp-dir <path>` — use a specific base directory for the temporary dump

Use only one of `--init`, `--check`, or `--dry-run`. Run `sync-mongo-s3 --help` for all connection and media flags.

### Common examples

```bash
sync-mongo-s3
sync-mongo-s3 --init
sync-mongo-s3 --check
sync-mongo-s3 --dry-run
sync-mongo-s3 --skip-s3
sync-mongo-s3 --skip-mongo --s3-bucket my-bucket --s3-prefix media
sync-mongo-s3 --remote-uri "mongodb+srv://..." --remote-db production --local-uri "mongodb://127.0.0.1/" --local-db development
```

## Environment variables

| Variable                                    | Required | Description                                     |
| ------------------------------------------- | -------- | ----------------------------------------------- |
| `SYNC_REMOTE_MONGO_URI`                     | Yes      | Connection string for the remote MongoDB        |
| `SYNC_LOCAL_MONGO_URI`                      | Yes      | Connection string for your local MongoDB        |
| `SYNC_REMOTE_MONGO_DB`                      | No       | Remote database name (prompted if omitted)      |
| `SYNC_LOCAL_MONGO_DB`                       | No       | Local database name (prompted if omitted)       |
| `SYNC_S3_BUCKET`                            | No       | S3 bucket to sync (prompted if omitted)         |
| `SYNC_S3_PREFIX`                            | No       | S3 prefix/folder within the bucket              |
| `SYNC_AWS_REGION`                           | No       | AWS region override                             |
| `SYNC_MEDIA_URL_REWRITE_HOST`               | No       | See [Media URL rewriting](#media-url-rewriting) |
| `SYNC_MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT` | No       | See [Media URL rewriting](#media-url-rewriting) |

MongoDB URIs are required only when MongoDB syncing is enabled. The remote database comes from `--remote-db`, `SYNC_REMOTE_MONGO_DB`, or the URI path; the local database uses the same precedence and defaults to `development`. The S3 bucket is required only when S3 syncing is enabled. Missing targets can be selected interactively; noninteractive runs must supply them. Use `--s3-prefix=` to override a configured prefix and sync the whole bucket, or choose `/` at the interactive prefix prompt.

`SYNC_AWS_REGION` overrides both AWS region environment variables. The AWS CLI continues to use its configured credentials/profile.

## Media URL rewriting

If your production Mongo documents store absolute CDN URLs (e.g. `https://cdn.example.com/media/image.jpg`) and you want them rewritten to point at your local `./s3-bucket` after restore, configure:

```bash
SYNC_MEDIA_URL_REWRITE_HOST=cdn.example.com
SYNC_MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT=true  # drops /media, leaving /image.jpg
```

or pass them as flags:

```bash
sync-mongo-s3 \
  --rewrite-media-host cdn.example.com \
  --rewrite-media-drop-first-segment
```

`--rewrite-media-drop-first-segment` strips the first path segment from the URL before mapping it to `./s3-bucket`. Useful when your CDN path includes a prefix (e.g. `/media/`) that doesn't exist in your local bucket directory.

## Restore behavior

MongoDB restore uses `--drop`, replacing collections present in the dump, and stops on the first restore error. Collections absent from the dump remain in the destination. Restore and media rewriting are not transactional: an error can leave partially restored or rewritten data. Temporary dumps are removed on success and failure unless `--keep-dump` is supplied.

The CLI rejects internal destination databases, unsafe database names, and matching source/destination databases on overlapping configured endpoints. It also recognizes common loopback aliases. Different DNS names can still point at the same server, so check the destination carefully with `--dry-run` before restoring. MongoDB URI authentication settings are preserved when selecting or remapping databases, including SRV TXT authentication settings.

S3 source listing is checked before MongoDB changes begin. This checks access to the selected bucket/prefix without requiring permission to list every bucket in the account. It does not prove download or MongoDB write permissions. S3 sync downloads new and changed files into `./s3-bucket`; it does not delete local files absent from S3. MongoDB and S3 updates are separate operations, so a later failure does not roll back an earlier one.

Media rewriting visits ordinary user collections, preserving BSON values and root document IDs. It skips views, time-series and system collections, and field names that cannot be safely addressed using dotted update paths. Only matching HTTP(S) URLs are rewritten.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` checks formatting, compiles the CLI, runs regression tests, and checks package contents. `pnpm test` runs the build and tests, `pnpm build` compiles the publishable CLI, and `pnpm format` formats source files. Tests use temporary directories, fake command executables, and mocked MongoDB calls; they do not contact live databases or buckets. CI runs on Node 20.19, 22, and 24.

Releases run from `main` when a commit message contains exactly one `(release:patch)`, `(release:minor)`, or `(release:major)` marker, or through the Release workflow's manual version-increment selection. `pnpm hooks:install` enables local marker validation. A failed npm publication can leave the version commit and tag in Git; check the registry and workflow failure before retrying.
