# classy

Classify a private media library with Ollama and computer vision models.

The indexer scans the `data/` directory recursively, fingerprints each file with
SHA-256, extracts local metadata, and stores classification results in a remote
SQLite-compatible database module.

## How It Works

1. The indexer initializes the `media_signatures` and `file_locations` tables.
2. It verifies that the configured Ollama models are available.
3. It scans files below `data/`.
4. It skips paths already recorded in `file_locations`.
5. It reuses metadata for duplicate file contents based on SHA-256.
6. It classifies photos, videos, and document text with Ollama.
7. It extracts audio and document metadata with the Python helpers.

Supported categories are determined from MIME types:

- Photos: `image/*`
- Videos: `video/*`
- Audio: `audio/*`
- PDF files: `application/pdf`
- EPUB and Mobipocket files

## Requirements

- Node.js with native `fetch` support
- Python 3
- FFmpeg and FFprobe for video files
- An Ollama server reachable from the indexer
- A database module importable by Node.js through `DATABASE_URL`

Install the JavaScript and Python dependencies with:

```sh
pnpm install
pip3 install -r requirements.txt
```

## Configuration

Set these environment variables before starting the indexer:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | None | Importable database module exposing `run()` and `get()` methods |
| `OLLAMA_URL` | Yes | None | Ollama chat API base URL |
| `VISION_MODEL` | No | `qwen2.5-vl:7b` | Model used for photos and video frames |
| `TEXT_MODEL` | No | `gemma2:27b` | Model used for PDFs and EPUBs |
| `SCAN_INTERVAL_HOURS` | No | `12` | Hours between background maintenance scans |
| `PORT` | For web process | None | Port used by the health-check server |

The input directory is fixed to `data/` relative to the process working
directory. Mount or copy the media library there.

## Running Locally

Start the classification worker:

```sh
DATABASE_URL="your-database-module" \
OLLAMA_URL="http://localhost:11434/v1" \
pnpm start
```

The application starts the HTTP health process, performs an initial scan, and
repeats maintenance scans every 12 hours by default. Each maintenance scan
removes database paths for files that no longer exist, then indexes new or
changed files. Trigger an immediate scan with:

```sh
curl -X POST http://localhost:3000/scan
```

Monitor the current scan with:

```sh
curl http://localhost:3000/status
```

The root endpoint responds with `OK`.

## Docker

The included Dockerfile installs Node.js dependencies, Python dependencies,
and FFmpeg. Build and run it with a mounted media directory and the required
environment variables:

```sh
docker build -t classy .
docker run --rm \
  -e DATABASE_URL="your-database-module" \
  -e OLLAMA_URL="http://ollama:11434/v1" \
  -v "$PWD/data:/app/data" \
  classy
```

The exact mount path must match the container's process working directory,
because the application resolves `data/` from `process.cwd()`.

## Deployment

The deployed health endpoint is available at:

<https://classy.api.apphor.de>

Check the deployment with:

```sh
curl https://classy.api.apphor.de
```

The expected response is `OK`.

Start a scan and inspect its progress with:

```sh
curl -X POST https://classy.api.apphor.de/scan
curl https://classy.api.apphor.de/status
```

The archive UI is available at the same URL. It is responsive, supports image,
audio, and video previews, and can be installed as a PWA from a compatible
browser.

### Media API

- `GET /api`: OpenAPI 3.1 JSON specification for third-party consumers.
- `GET /api/media`: paginated indexed media. Supports `search`, `type`, `category`, `limit`, and `offset`.
- `GET /api/media/:id`: full metadata for one indexed file.
- `GET /api/media/:id/content`: stream the original file, including byte ranges for video and audio playback.
- `GET /api/status`: scan counters and the current index location.
- `POST /api/scan`: trigger a new scan and return immediately with `202`.

The status response includes `removed`, `lastPrunedAt`, and
`nextScheduledAt` for maintenance-loop visibility.

For CI schedulers or backup hooks, call the API after the files are available
on storage. The deployed service is protected by basic auth, so keep the
credentials in the scheduler's secret store:

```sh
curl --fail --user "$CLASSY_USER:$CLASSY_PASSWORD" \
  -X POST https://classy.api.apphor.de/api/scan
```

Poll the returned status endpoint when a completion check is needed:

```sh
curl --fail --user "$CLASSY_USER:$CLASSY_PASSWORD" \
  https://classy.api.apphor.de/api/status
```

## Database Tables

### `media_signatures`

Stores one classification record per unique SHA-256 file content:

- `sha256`: primary key
- `file_type`: detected media type
- `extracted_date`: file or embedded metadata date
- `ai_category`: broad classification
- `ai_summary`: generated description
- `raw_metadata`: JSON-encoded extractor metadata
- `llm_error`: Ollama or response-parsing error when classification fails

### `file_locations`

Stores every indexed path:

- `id`: auto-incrementing identifier
- `sha256`: content hash
- `file_path`: unique indexed path
- `file_size`: size at indexing time

## Python Extractors

- `extract_audio.py` reads ID3 metadata with `eyed3` and falls back to artist
  and album names inferred from parent directories.
- `extract_doc.py` reads the first two PDF pages or the first EPUB document
  contents and returns a text excerpt for classification.

Extractor failures are returned as empty metadata rather than stopping the
entire scan.

## Operational Notes

- A path is considered processed once it is inserted into `file_locations`.
  Replacing a file at an already indexed path does not currently trigger a
  re-scan.
- Duplicate content is classified once; additional paths only receive a
  location record.
- Failed LLM classifications retain their error reason in `llm_error` and are
  retried on the next scan.
- Video processing creates temporary frame files under `/tmp/frames`.
- The Ollama model pull step can take significant time, especially for the
  default 27B text model.
- There are currently no automated tests in the repository.
