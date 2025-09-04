import axios from 'axios';

const IMMICH_BASE_URL = process.env.IMMICH_BASE_URL || 'http://localhost:2283';
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || '';

// Action switches
const BESTSHOT_ACTION = (process.env.BESTSHOT_ACTION || 'favorite_only') as
  | 'favorite_only'
  | 'favorite_and_hide'
  | 'delete_alternates';
const APPLY_CHANGES = (process.env.APPLY_CHANGES || 'false').toLowerCase() === 'true';

// Review album mode (non-destructive “dry run” subset)
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

  const { data } = await api.post('/api/albums', { albumName: name }); // album.create
  return data;
}

/**
 * Add assets to a single album, with version-compat fallback:
 * 1) Try POST /api/albums/{id}/assets  (newer servers)
 * 2) On 404, try POST /api/albums/assets with { albumIds, assetIds } (older/alt servers)
 * Requires albumAsset.create scope.
 */
async function addAssetsToAlbum(albumId: string, ids: string[]) {
  if (!ids.length) return;
  try {
    // Attempt per-album endpoint
    const { data } = await api.post(`/api/albums/${albumId}/assets`, { ids });
    if (Array.isArray(data)) {
      const ok = data.filter((r: any) => r?.success).length;
      const fails = data.filter((r: any) => !r?.success);
      if (fails.length) {
        console.warn(
          `Album ${albumId}: added ${ok}/${data.length}; failures: ` +
            fails.map((f: any) => `${f?.id}:${f?.error || 'unknown'}`).join(', ')
        );
      } else {
        console.log(`Album ${albumId}: added ${ok}/${data.length} assets`);
      }
      return;
    }
    console.log(`Album ${albumId}: add-assets (per-album) returned`, data);
  } catch (err: any) {
    const status = err?.response?.status;
    const body = err?.response?.data || err?.message;
    if (status === 404) {
      console.warn(
        `Per-album endpoint not found on this server (404). Falling back to bulk addAssetsToAlbums for ${albumId}.`
      );
      // Fallback: bulk endpoint
      try {
        const { data } = await api.post(`/api/albums/assets`, {
          albumIds: [albumId],
          assetIds: ids,
        });
        // Expect shape: { albumSuccessCount, assetSuccessCount, success, error? }
        if (data?.success === false) {
          console.warn(
            `Bulk addAssetsToAlbums: partial/failed. albumSuccessCount=${data?.albumSuccessCount} assetSuccessCount=${data?.assetSuccessCount} error=${data?.error}`
          );
        } else {
          console.log(
            `Bulk addAssetsToAlbums: albumSuccessCount=${data?.albumSuccessCount} assetSuccessCount=${data?.assetSuccessCount}`
          );
        }
        return;
      } catch (e: any) {
        console.error(
          `Fallback bulk addAssetsToAlbums failed for album ${albumId}:`,
          e?.response?.data || e?.message || e
        );
        return;
      }
    } else {
      console.error(`Album ${albumId}: add-assets (per-album) failed:`, body);
      return;
    }
  }
}

// -------- selection (placeholder; plug in scoring later) --------
function pickBest(assetIds: string[]): { best: string; others: string[] } {
  const best = assetIds[0];
  const others = assetIds.slice(1);
  return { best, others };
}

// -------- actions --------
async function applyNormalActions(group: DuplicateGroup, bestId: string, others: string[]) {
  console.log(`Normal mode: would mark ${bestId} as favorite. Mode=${BESTSHOT_ACTION}.`);
  if (!APPLY_CHANGES) return;

  await bulkFavorite([bestId]);

  if (BESTSHOT_ACTION === 'favorite_and_hide' && others.length) {
    await bulkHide(others);
  }

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
    `Review mode: add winner ${bestId} -> "${WINNERS_ALBUM_NAME}", alternates (${others.length}) -> "${ALTERNATES_ALBUM_NAME}"`
  );

  if (!APPLY_CHANGES) return;

  await addAssetsToAlbum(winnersAlbumId, [bestId]);
  await addAssetsToAlbum(alternatesAlbumId, others);
}

// -------- main --------
async function main() {
  console.log('Best Shot Selector starting…');
  console.log(
    `Flags ⇒ REVIEW_ALBUM_MODE=${REVIEW_ALBUM_MODE} REVIEW_ALBUM_LIMIT=${REVIEW_ALBUM_LIMIT} BESTSHOT_ACTION=${BESTSHOT_ACTION} APPLY_CHANGES=${APPLY_CHANGES}`
  );

  if (!IMMICH_API_KEY) {
    console.error('Missing IMMICH_API_KEY in env vars');
    process.exit(1);
  }

  try {
    const groups = await getDuplicateGroups();
    console.log(`Found ${groups.length} duplicate groups.`);

    if (REVIEW_ALBUM_MODE) {
      const winners = await getOrCreateAlbumByName(WINNERS_ALBUM_NAME);
      const alternates = await getOrCreateAlbumByName(ALTERNATES_ALBUM_NAME);

      console.log(
        `Review mode ON (limit ${REVIEW_ALBUM_LIMIT}). Winners="${albumDisplayName(
          winners
        )}", Alternates="${albumDisplayName(alternates)}".`
      );

      const slice = groups.slice(0, REVIEW_ALBUM_LIMIT);
      let processed = 0;

      for (const g of slice) {
        const assetIds = (g.assets ?? []).map(a => a.id).filter(Boolean);
        if (!assetIds.length) {
          console.log(`Group ${g.duplicateId}: no assets, skipping`);
          continue;
        }
        const { best, others } = pickBest(assetIds);
        console.log(`Group ${g.duplicateId}: best=${best}, others=${others.length} [review]`);
        await applyReviewAlbumActions(winners.id, alternates.id, best, others);
        processed++;
      }

      console.log(
        `Done (review). Apply=${APPLY_CHANGES} Processed=${processed} WinnersAlbum="${albumDisplayName(
          winners
        )}" AlternatesAlbum="${albumDisplayName(alternates)}"`
      );
      return;
    }

    console.log(`Normal mode ON. BESTSHOT_ACTION=${BESTSHOT_ACTION}`);
    let processed = 0;

    for (const g of groups) {
      const assetIds = (g.assets ?? []).map(a => a.id).filter(Boolean);
      if (!assetIds.length) {
        console.log(`Group ${g.duplicateId}: no assets, skipping`);
        continue;
      }
      const { best, others } = pickBest(assetIds);
      console.log(`Group ${g.duplicateId}: best=${best}, others=${others.length}`);
      await applyNormalActions(g, best, others);
      processed++;
    }

    console.log(`Done (normal). Mode=${BESTSHOT_ACTION} Apply=${APPLY_CHANGES} Processed=${processed}`);
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
