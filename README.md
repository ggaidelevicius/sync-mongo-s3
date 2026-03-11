# @ggaidelevicius/sync-mongo-s3

CLI for:

- dumping a remote MongoDB database with `mongodump`
- restoring it into a local MongoDB database with `mongorestore`
- syncing an S3 bucket or prefix into `./s3-bucket`

## Requirements

- Node `>=20.9.0`
- AWS CLI installed and already authenticated
- MongoDB Database Tools installed (`mongodump`, `mongorestore`)

## Install

```bash
pnpm add -D @ggaidelevicius/sync-mongo-s3
```

or run it without installing:

```bash
pnpm dlx @ggaidelevicius/sync-mongo-s3 --help
```

## Usage

```bash
sync-mongo-s3
```

The CLI prompts interactively when values are missing and tries to list:

- remote Mongo databases
- local Mongo databases
- available S3 buckets
- top-level S3 prefixes

On first run, the CLI checks the project’s `.env*` files for the minimum `SYNC_*` setup. Right now that is just the remote and local Mongo URI placeholders. If they are missing, it offers to add them to the most relevant env file, tells you exactly what it wrote, and stops so you can fill in your own values.

Useful modes:

- `sync-mongo-s3 --init` scaffolds the minimum `SYNC_*` placeholders
- `sync-mongo-s3 --check` validates config, tooling, auth, and discovery without syncing
- `sync-mongo-s3 --dry-run` prints the resolved sync plan and commands without executing them

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

Preferred env vars:

- `SYNC_REMOTE_MONGO_URI`
- `SYNC_REMOTE_MONGO_DB`
- `SYNC_LOCAL_MONGO_URI`
- `SYNC_LOCAL_MONGO_DB`
- `SYNC_S3_BUCKET`
- `SYNC_S3_PREFIX`
- `SYNC_AWS_REGION`
- `SYNC_MEDIA_URL_REWRITE_HOST`
- `SYNC_MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT`

Only `SYNC_REMOTE_MONGO_URI` and `SYNC_LOCAL_MONGO_URI` are scaffolded during first-run initialization. The rest are optional shortcuts; the CLI can prompt for database and bucket selection interactively.

## Media URL rewriting

If you want restored Mongo documents to rewrite absolute media URLs to local `/s3-bucket/...` paths, configure:

```bash
SYNC_MEDIA_URL_REWRITE_HOST=cdn.example.com
SYNC_MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT=true
```

or use:

```bash
sync-mongo-s3 \
  --rewrite-media-host cdn.example.com \
  --rewrite-media-drop-first-segment
```

This is useful when production documents store absolute CDN URLs but local development should serve files from the synced `./s3-bucket` directory.

## Release flow

This repo includes the same basic publish scaffolding as `payload-isr`:

- GitHub release workflow on `main`
- commit message release markers
- issue templates
- pull request template

Release commits should include exactly one of:

- `(release:patch)`
- `(release:minor)`
- `(release:major)`
