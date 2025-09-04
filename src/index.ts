import axios from 'axios';

const IMMICH_BASE_URL = process.env.IMMICH_BASE_URL || "http://localhost:2283";
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || "";
const BESTSHOT_ACTION = (process.env.BESTSHOT_ACTION || "favorite_only") as
  | "favorite_only"
  | "favorite_and_hide"
  | "delete_alternates";
const APPLY_CHANGES = (process.env.APPLY_CHANGES || "false").toLowerCase() === "true";

type DuplicateGroup = {
  id: string;
  assets?: Array<{ id: string }>;
};

const api = axios.create({
  baseURL: IMMICH_BASE_URL,
  headers: { "x-api-key": IMMICH_API_KEY },
  timeout: 30000,
});

async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  const { data } = await api.get("/api/duplicates");
  return Array.isArray(data) ? data : [];
}

async function applyAction(group: DuplicateGroup, bestId: string, others: string[]) {
  console.log(`Would mark ${bestId} as favorite. Mode=${BESTSHOT_ACTION}.`);
  if (!APPLY_CHANGES) return;

  try {
    await api.put("/api/assets", { ids: [bestId], isFavorite: true });

    if (BESTSHOT_ACTION === "favorite_and_hide" && others.length) {
      await api.put("/api/assets", { ids: others, visibility: "hidden" });
    }

    if (BESTSHOT_ACTION === "delete_alternates" && others.length) {
      await api.delete(`/api/duplicates/${group.id}`);
    }
  } catch (e: any) {
    console.error("Failed to apply action:", e?.message || e);
  }
}

async function main() {
  console.log("Best Shot Selector started...");
  if (!IMMICH_API_KEY) {
    console.error("Missing IMMICH_API_KEY in env vars");
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

      // placeholder selection until scoring is added back
      const best = assetIds[0];
      const others = assetIds.slice(1);
      console.log(`Group ${g.id}: picking ${best} as best, others=${others.length}`);

      await applyAction(g, best, others);
    }
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      console.error("Immich API error:", err.response?.status, err.response?.data || err.message);
    } else {
      console.error("Unexpected error:", err);
    }
    process.exit(1);
  }
}

main();
