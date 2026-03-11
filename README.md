# @ggaidelevicius/sync-mongo-s3

A CLI for pulling your remote production environment down to local. It dumps a remote MongoDB database and restores it locally, and syncs an S3 bucket (or prefix) into `./s3-bucket` — all in one command.

Useful when you want to develop against real data without manually wrangling `mongodump`, `mongorestore`, and the AWS CLI every time.

## Requirements

- Node `>=20.9.0`
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

On first run, the CLI checks your project's `.env*` files for the minimum `SYNC_*` setup. If the URI placeholders are missing, it offers to add them to the most relevant env file, tells you exactly what it wrote, and stops so you can fill in your own values.

### Flags

- `--init` — scaffold the minimum `SYNC_*` placeholders into your env file
- `--check` — validate config, tooling, auth, and discovery without syncing
- `--dry-run` — print the resolved sync plan and commands without executing them
- `--skip-s3` — skip the S3 sync, only run the Mongo dump/restore
- `--skip-mongo` — skip the Mongo dump/restore, only run the S3 sync

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

| Variable | Required | Description |
|---|---|---|
| `SYNC_REMOTE_MONGO_URI` | Yes | Connection string for the remote MongoDB |
| `SYNC_LOCAL_MONGO_URI` | Yes | Connection string for your local MongoDB |
| `SYNC_REMOTE_MONGO_DB` | No | Remote database name (prompted if omitted) |
| `SYNC_LOCAL_MONGO_DB` | No | Local database name (prompted if omitted) |
| `SYNC_S3_BUCKET` | No | S3 bucket to sync (prompted if omitted) |
| `SYNC_S3_PREFIX` | No | S3 prefix/folder within the bucket |
| `SYNC_AWS_REGION` | No | AWS region override |
| `SYNC_MEDIA_URL_REWRITE_HOST` | No | See [Media URL rewriting](#media-url-rewriting) |
| `SYNC_MEDIA_URL_REWRITE_DROP_FIRST_SEGMENT` | No | See [Media URL rewriting](#media-url-rewriting) |

Only `SYNC_REMOTE_MONGO_URI` and `SYNC_LOCAL_MONGO_URI` are required. Everything else is an optional shortcut — the CLI will prompt interactively for anything missing.

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
