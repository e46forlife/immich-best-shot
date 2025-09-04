import axios from 'axios';

const IMMICH_BASE_URL = process.env.IMMICH_BASE_URL || 'http://localhost:2283';
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || '';
const BESTSHOT_ACTION = (process.env.BESTSHOT_ACTION || 'favorite_only') as
  | 'favorite_only'
  | 'favorite_and_hide'
  | 'delete_alternates';
const APPLY_CHANGES = (process.env.APPLY_CHANGES || 'false').toLowerCase() === 'true';

type DuplicateAsset = { id: string };
type DuplicateGroup = {
  duplicateId: string;              // <-- correct field from Immich
  assets?: DuplicateAsset[];        // can be missing or empty
};

const api = axios.create({
  baseURL: IMMICH_BASE_URL,
  headers: { 'x-api-key': IMMICH_API_KEY },
  timeout: 30000,
});

async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  const { data } = await api.get('/api/duplicates');  // requires duplicate.read
  return Array.isArray(data) ? data : [];
}

async function favoriteAssets(ids: string[]) {
  if (!ids.length) return;
  await api.put('/api/assets', { ids, isFavorite: true }); // bulk favorite
}

async function hideAssets(ids: string[]) {
  if (!ids.length) return;
  await api.put('/api/assets', { ids, visibility: 'hidden' }); // bulk hide
}

async function deleteDuplicateGroup(groupId: string) {
  await api.delete(`/api/duplicates/${groupId}`); // deletes the whole group
}

async function applyAction(group: DuplicateGroup, bestId: string, others: string[]) {
  console.log(`Would mark ${bestId} as favorite. Mode=${BESTSHOT_ACTION}.`);
  if (!APPLY_CHANGES) return;

  try {
    // 1) Favorite the best
    await favoriteAssets([bestId]);

    // 2) Hide alternates (optional)
    if (BESTSHOT_ACTION === 'favorite_and_hide' && others.length) {
      await hideAssets(others);
    }

    // 3) Delete entire duplicate group (dangerous; optional)
    if (BESTSHOT_ACTION === 'delete_alternates' && others.length) {
      await deleteDuplicateGroup(group.duplicateId);
    }
  } catch (e: any) {
    console.error('Failed to apply action:', e?.message || e);
  }
}

/**
 * Placeholder "best" selection.
 * For now we just pick the first asset; later we can plug in scoring (sharpness/exposure/noise).
 */
function pickBest(assetIds: string[]): { best: string; others: string[] } {
  const best = assetIds[0];
  const others = assetIds.slice(1);
  return { best, others };
}

async function main() {
  console.log('Best Shot Selector started...');
  if (!IMMICH_API_KEY) {
    console.error('Missing IMMICH_API_KEY in env vars');
    process.exit(1);
  }

  try {
    const groups = await getDuplicateGroups();
    console.log(`Found ${groups.length} duplicate groups.`);

    for (const g of groups) {
      const assetIds = (g.assets ?? []).map(a => a.id).filter(Boolean);
      if (!assetIds.length) {
        console.log(`Group ${g.duplicateId}: no assets, skipping`);
        continue;
      }

      const { best, others } = pickBest(assetIds);
      console.log(`Group ${g.duplicateId}: picking ${best} as best, others=${others.length}`);

      await applyAction(g, best, others);
    }

    console.log(`Done. Mode=${BESTSHOT_ACTION} Apply=${APPLY_CHANGES}`);
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
