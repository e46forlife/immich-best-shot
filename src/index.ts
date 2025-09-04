type DuplicateGroup = {
  id: string;              // duplicate group id
  assets?: Array<{ id: string }>; // assets in the group
};

// Fetch groups
async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  const { data } = await api.get('/api/duplicates'); // requires duplicate.read
  return data;
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
      const assetIds = (g.assets ?? []).map(a => a.id);
      if (!assetIds.length) {
        console.log(`Group ${g.id}: no assets, skipping`);
        continue;
      }

      // TODO: replace with scoring; for now pick first for sanity
      const best = assetIds[0];
      const others = assetIds.slice(1);

      console.log(`Group ${g.id}: picking ${best} as best, others=${others.length}`);
      await applyAction(g, best, others);
    }
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      console.error('Immich API error:', err.response?.status, err.response?.data || err.message);
    } else {
      console.error('Unexpected error:', err);
    }
    process.exit(1);
  }
}
