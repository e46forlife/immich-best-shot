# Immich Best Shot Selector

This service finds groups of similar/duplicate photos in Immich and (in the full version) will score them to mark a best shot.

## Quick start (Docker Hub / Unraid)
1) Set env vars in Unraid:
- `IMMICH_BASE_URL` (e.g., `http://<immich-ip>:2283`)
- `IMMICH_API_KEY`
- `BESTSHOT_ACTION` (`favorite_only` | `favorite_and_hide` | `delete_alternates`)

2) Point Unraid at your Docker Hub image: `<dockerhub-username>/immich-best-shot:latest`

## Local build
```bash
npm install
npm run build
node dist/index.js
```

## Docker build
```bash
docker build -t immich-best-shot .
docker run --rm --env-file .env --network=host immich-best-shot
```

## Notes
- Start in `favorite_only` while testing.
- The code currently lists duplicate groups. Scoring logic can be added once deployment is stable.
