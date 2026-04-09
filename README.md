# media-ingest

Media ingest monorepo for asynchronous media transcription and understanding.

## Packages

- `apps/api`: NestJS REST API.
- `packages/media-ingest-core`: shared pipeline, providers, sources, and persistence.
- `packages/media-ingest-cli`: CLI for API interaction and direct local-file processing.

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Copy and adjust the config:

```bash
cp config/app.example.yaml config/app.yaml
```

3. Set a remote Postgres/Neon URL in `config/app.yaml` or `DATABASE_URL`.

4. Run the API:

```bash
pnpm db:migrate
pnpm dev:api
```

5. Or run the API container:

```bash
docker compose up -d api
```

6. See CLI help:

```bash
pnpm cli --help
```

7. Link the CLI globally so `media-ingest` is available in `PATH`:

```bash
pnpm cli:link-global
media-ingest --help
```

If `media-ingest` is still not found afterwards, make sure your shell `PATH` includes `$(pnpm bin -g)`.

## Database Migrations

Schema changes are tracked with SQL migrations in `packages/media-ingest-core/drizzle`. Apply them with:

```bash
pnpm db:migrate
```

The API startup checks and applies pending migrations once; already-applied migrations are skipped without re-running the SQL.

## Docker Notes

The API container includes `ffmpeg` and `yt-dlp`.

For local development, leave both cookie settings empty unless plain `yt-dlp` is not enough.

For Docker, the default setup now uses Firefox cookies via `yt-dlp --cookies-from-browser firefox`. Mount the Ubuntu Firefox profile directory into the container and let the env override drive the browser selection:

```bash
export MEDIA_INGEST_FIREFOX_DIR="$HOME/.mozilla/firefox"
docker compose up -d api
```

If your Ubuntu host uses the Firefox Snap layout, use:

```bash
export MEDIA_INGEST_FIREFOX_DIR="$HOME/snap/firefox/common/.mozilla/firefox"
docker compose up -d api
```

If `yt-dlp` needs a specific Firefox profile, override the selector:

```bash
export YT_DLP_COOKIES_FROM_BROWSER='firefox:default-release'
docker compose up -d api
```

The container mounts the Firefox data under `/root/.mozilla/firefox`, which is the path `yt-dlp` expects for Firefox on Linux.

## Google Auth Notes

Gemini and Google Cloud are configured separately.

- `providers.gemini.apiKey` is used for Gemini API calls and does not require a project id.
- `providers.googleCloud.projectId` and `providers.googleCloud.serviceAccountJson` are used for Google Drive and Google Cloud Speech integrations.
- `database.url` should point to a remote Postgres-compatible database such as Neon. This repo does not provision a local database.

## Testing

```bash
pnpm lint
pnpm test
pnpm typecheck
```

## CLI Examples

```bash
media-ingest transcribe /absolute/path/to/file.mp4 --provider openai
media-ingest understand /absolute/path/to/file.mp4 --provider google-gemini --prompt "Summarize this video"
media-ingest transcribe submit --source-kind youtube --source-uri "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --provider openai
media-ingest understand submit --source-kind http --source-uri "https://example.com/video.mp4" --provider google-gemini --prompt "Describe this video"
media-ingest status <operationId>
```
