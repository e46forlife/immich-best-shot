import axios from 'axios';

const IMMICH_BASE_URL = process.env.IMMICH_BASE_URL || "http://localhost:2283";
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || "";
const BESTSHOT_ACTION = (process.env.BESTSHOT_ACTION || "favorite_only") as "favorite_only" | "favorite_and_hide" | "delete_alternates";

type DuplicateGroup = {
  duplicateId: string;
  assetIds: string[];
};

async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  const url = `${IMMICH_BASE_URL}/api/duplicates/assets`;
  const { data } = await axios.get(url, {
    headers: { 'x-api-key': IMMICH_API_KEY }
  });
  return data;
}

async function main() {
  console.log("Best Shot Selector started...");
  if (!IMMICH_API_KEY) {
    console.error("Missing IMMICH_API_KEY in environment variables");
    process.exit(1);
  }

  try {
    const groups = await getDuplicateGroups();
    console.log(`Found ${groups.length} duplicate groups.`);

    // Placeholder: just log for now. Scoring will be added in next step.
    for (const g of groups) {
      console.log(`Group ${g.duplicateId} has ${g.assetIds.length} assets.`);
    }

    console.log(`Action mode: ${BESTSHOT_ACTION}`);
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
