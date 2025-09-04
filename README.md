# Immich Best Shot Selector

This is a plugin-like service for Immich that uses duplicate detection and automatically chooses the best photo (based on quality metrics like sharpness, exposure, and framing).

## Usage

1. Copy `.env.example` to `.env` and fill in values.
2. Build and run with Docker:
   ```bash
   docker build -t immich-best-shot .
   docker run --rm --env-file .env --network=host immich-best-shot
   ```

## Environment Variables

- `IMMICH_BASE_URL` — URL of your Immich instance (default `http://localhost:2283`).
- `IMMICH_API_KEY` — API key from Immich Admin.
- `BESTSHOT_ACTION` — what to do with alternates (`favorite_only`, `favorite_and_hide`, `delete_alternates`).

## GitHub Actions

The repo includes a workflow in `.github/workflows/docker-build.yml` to build and publish this container to GitHub Container Registry (GHCR).

