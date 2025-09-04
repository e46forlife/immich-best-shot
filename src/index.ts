import axios from 'axios';

const IMMICH_BASE_URL = process.env.IMMICH_BASE_URL || 'http://localhost:2283';
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || '';

// Action switches
const BESTSHOT_ACTION = (process.env.BESTSHOT_ACTION || 'favorite_only') as
  | 'favorite_only'
  | 'favorite_and_hide'
  | 'delete_alternates';
const APPLY_CHANGES = (process.env.APPLY_CHANGES || 'false').toLowerCase() === 'true';

// Review album mode (non-destructive “dry run” for a subset of groups)
const REVIEW_ALBUM_MODE = (process.env.REVIEW_ALBUM_MODE || 'false').toLowerCase() === 'true';
const REVIEW_ALBUM_LIMIT = Number(process.env.REVIEW_ALBUM_LIMIT || '10');
const WINNERS_ALBUM_NAME = process.env.WINNERS_ALBUM_NAME || 'Best-Shot Review — Winners';
const ALTERNATES_ALBUM_NAME = process.env.ALTERNATES_ALBUM_NAME || 'Best-Shot Review — Alternates';

type DuplicateAsset = { id: string };
type DuplicateGroup = {
  duplicateId: string;
  assets?: DuplicateAsset[];
};

type Album = {
  id: string;
  albumName?: string;
  name?: string;
};

const api = axios.create({
  baseURL: IMMICH_BASE_URL,
  headers: { 'x-api-key': IMMICH_API_KEY },
  timeout: 60000,
});

// -------- API helpers --------
async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  const { data } = await api.get('/api/duplicates'); // requires duplicate.read
  return Array.isArray(data) ? data : [];
}

async function bulkFavorite(ids: string[]) {
  if (!ids.length) return;
  await api.put('/api/assets', { ids, isFavorite: true }); // asset.update
}

async function bulkHide(ids: string[]) {
  if (!ids.length) return;
  await api.put('/api/assets', { ids, visibility: 'hidden' }); // asset.update
}

async function deleteDuplicateGroup(groupId: string) {
  await api.delete(`/api/duplicates/${groupId}`); // duplicate.delete
}

async function listAlbums(): Promise<Album[]> {
  const { data } = await api.get('/api/albums'); // album.read
  return Array.isArray(data) ? data : [];
}

function albumDisplayName(a: Album): string {
  return a.albumName || a.name || '';
}

async function getOrCreateAlbumByName(name: string): Promise<Album> {
  const albums = await listAlbums();
  const found = albums.find(a => albumDisplayName(a) === name);
  if (found) return found;

  // create empty album
  const { data } = await api.post('/api/albums', { albumName: name }); // album.create
  return data;
}

async function addAssetsToAlbum(albumId: string, ids: string[]) {
  if (!ids.length) return;
  await api.post(`/api/albums/${albumId}/assets`, { ids }); // album.update (add assets)
}

// -------- selection (placeholder; plug in scoring later) --------
function pickBest(assetIds: string[]): { best: string; others: string[] } {
  const best = assetIds[0];
  const others = assetIds.slice(1);
  return { best, others };
}

// -------- actions --------
async function applyNormalActions(group: DuplicateGroup, bestId: string, others: string[]) {
  console.log(`Would mark ${bestId} as favorite. Mode=${BESTSHOT_ACTION}.`);
  if (!APPLY_CHANGES) return;

  // 1) favorite winner
  await bulkFavorite([bestId]);

  // 2) optionally hide alternates
  if (BESTSHOT_ACTION === 'favorite_and_hide' && others.length) {
    await bulkHide(others);
  }

  // 3) optionally delete entire duplicate group (danger!)
  if (BESTSHOT_ACTION === 'delete_alternates' && others.length) {
    await deleteDuplicateGroup(group.duplicateId);
  }
}

async function applyReviewAlbumActions(
  winnersAlbumId: string,
  alternatesAlbumId: string,
  bestId: string,
  others: string[],
) {
  console.log(
    `Review mode: add winner ${bestId} -> "${WINNERS_ALBUM_NAME}", alternates (${others.length}) -> "${ALTERNATES_ALBUM_NAME}"`,
  );

  // Non-destructive even when APPLY_CHANGES=false? Your call:
  // - To keep "review" truly dry, only write when APPLY_CHANGES=true.
  // - If you want album writes regardless, set the if to always true.
  if (!APPLY_CHANGES) return;

  await addAssetsToAlbum(winnersAlbumId, [bestId]);
  await addAssetsToAlbum(alternatesAlbumId, others);
}

// -------- main --------
async function main() {
  console.log('Best Shot Selector started...');
  if (!IMMICH_API_KEY) {
    console.error('Missing IMMICH_API_KEY in env vars');
    process.exit(1);
  }

  try {
    const groups = await getDuplicateGroups();
    console.log(`Found ${groups.length} duplicate groups.`);

    let winnersAlbumId: string | null = null;
    let alternatesAlbumId: string | null = null;

    if (REVIEW_ALBUM_MODE) {
      // Prep albums once
      const winners = await getOrCreateAlbumByName(WINNERS_ALBUM_NAME);
      const alternates = await getOrCreateAlbumByName(ALTERNATES_ALBUM_NAME);
      winnersAlbumId = winners.id;
      alternatesAlbumId = alternates.id;
      console.log(
        `Review mode ON (limit ${REVIEW_ALBUM_LIMIT}). Winners album="${albumDisplayName(
          winners,
        )}", Alternates album="${albumDisplayName(alternates)}". APPLY_CHANGES=${APPLY_CHANGES}`,
      );
    } else {
      console.log(`Normal mode. BESTSHOT_ACTION=${BESTSHOT_ACTION} APPLY_CHANGES=${APPLY_CHANGES}`);
    }

    const slice = REVIEW_ALBUM_MODE ? groups.slice(0, REVIEW_ALBUM_LIMIT) : groups;
    let processed = 0;

    for (const g of slice) {
      const assetIds = (g.assets ?? []).map(a => a.id).filter(Boolean);
      if (!assetIds.length) {
        console.log(`Group ${g.duplicateId}: no assets, skipping`);
        continue;
      }

      const { best, others } = pickBest(assetIds);
      console.log(
        `Group ${g.duplicateId}: picking ${best} as best, others=${others.length}${
          REVIEW_ALBUM_MODE ? ' [review]' : ''
        }`,
      );

      if (REVIEW_ALBUM_MODE && winnersAlbumId && alternatesAlbumId) {
        await applyReviewAlbumActions(winnersAlbumId, alternatesAlbumId, best, others);
      } else {
        await applyNormalActions(g, best, others);
      }
      processed++;
    }

    console.log(
      `Done. Mode=${REVIEW_ALBUM_MODE ? 'review-albums' : BESTSHOT_ACTION} Apply=${APPLY_CHANGES} Processed=${processed}`,
    );
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      console.error('Immich API error:', err.response?.status, err.response?.data || err.message);
    } else {
      console.error('Unexpected error:', err);
    }
    process.exit(1);
  }
}

main();
