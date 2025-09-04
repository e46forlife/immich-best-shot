import axios from 'axios';

const IMMICH_BASE_URL = process.env.IMMICH_BASE_URL || "http://localhost:2283";
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || "";

async function main() {
  console.log("Best Shot Selector started...");
  if (!IMMICH_API_KEY) {
    console.error("Missing IMMICH_API_KEY in environment variables");
    process.exit(1);
  }

  try {
    const res = await axios.get(`${IMMICH_BASE_URL}/api/duplicates`, {
      headers: { 'x-api-key': IMMICH_API_KEY }
    });

    const groups = res.data;
    console.log(`Found ${groups.length} duplicate groups.`);
    // TODO: add photo scoring and best-shot logic here
  } catch (err) {
    console.error("Error communicating with Immich:", err);
  }
}

main();
