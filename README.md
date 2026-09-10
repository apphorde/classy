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

The application starts the HTTP health process and performs an initial scan.
Trigger another scan with:

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

## Database Tables

### `media_signatures`

Stores one classification record per unique SHA-256 file content:

- `sha256`: primary key
- `file_type`: detected media type
- `extracted_date`: file or embedded metadata date
- `ai_category`: broad classification
- `ai_summary`: generated description
- `raw_metadata`: JSON-encoded extractor metadata

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
- Video processing creates temporary frame files under `/tmp/frames`.
- The Ollama model pull step can take significant time, especially for the
  default 27B text model.
- There are currently no automated tests in the repository.
