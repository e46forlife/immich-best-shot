import axios from 'axios';
import * as jpeg from 'jpeg-js';

/**
 * Immich Best Shot — Hybrid Scoring
 * - Uses Immich metadata (faces/tags) when available
 * - Computes sharpness (variance of Laplacian), exposure/brightness, and a light composition score from preview
 * - Picks the highest scoring asset per duplicate group
 * - Review mode: adds winners/alternates to albums for the first N groups
 */

// ===== ENV =====
const IMMICH_BASE_URL = process.env.IMMICH_BASE_URL || 'http://localhost:2283';
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || '';

const BESTSHOT_ACTION = (process.env.BESTSHOT_ACTION || 'favorite_only') as
  | 'favorite_only'
  | 'favorite_and_hide'
  | 'delete_alternates';
const APPLY_CHANGES = (process.env.APPLY_CHANGES || 'false').toLowerCase() === 'true';

const REVIEW_ALBUM_MODE = (process.env.REVIEW_ALBUM_MODE || 'false').toLowerCase() === 'true';
const REVIEW_ALBUM_LIMIT = Number(process.env.REVIEW_ALBUM_LIMIT || '10');
const WINNERS_ALBUM_NAME = process.env.WINNERS_ALBUM_NAME || 'Best-Shot Review — Winners';
const ALTERNATES_ALBUM_NAME = process.env.ALTERNATES_ALBUM_NAME || 'Best-Shot Review — Alternates';

// Use Immich AI metadata (faces/tags) if present
const USE_IMMICH_AI = (process.env.USE_IMMICH_AI || 'true').toLowerCase() === 'true';

// Thumbnail strategy
const THUMBNAIL_SIZE = process.env.THUMBNAIL_SIZE || 'preview'; // 'preview' | 'thumbnail'
const THUMBNAIL_MAX_BYTES = Number(process.env.THUMBNAIL_MAX_BYTES || '2000000'); // 2MB cap

// Scoring weights
type Weights = { sharpness: number; exposure: number; face: number; tags: number };
const DEFAULT_WEIGHTS: Weights = { sharpness: 0.45, exposure: 0.25, face: 0.2, tags: 0.1 };
const SCORING_WEIGHTS: Weights = parseWeights(process.env.SCORING_WEIGHTS) || DEFAULT_WEIGHTS;

// ===== Types =====
type DuplicateAsset = { id: string };
type DuplicateGroup = { duplicateId: string; assets?: DuplicateAsset[] };

type Album = { id: string; albumName?: string; name?: string };

type SmartInfo = {
  tags?: string[];
  people?: any[];
  faces?: Array<{ boundingBox?: { x: number; y: number; width: number; height: number } }>;
};

type Asset = {
  id: string;
  exifInfo?: { iso?: number; exposureTime?: string; fNumber?: number };
  smartInfo?: SmartInfo;
  // width/height may or may not be present; we compute from preview
};

// ===== API client =====
const api = axios.create({
  baseURL: IMMICH_BASE_URL,
  headers: { 'x-api-key': IMMICH_API_KEY },
  timeout: 60000,
});

// ===== Helpers =====
function parseWeights(s?: string | null): Weights | null {
  if (!s) return null;
  try {
    const parts = s.split(',').map(p => p.trim());
    const out: any = {};
    for (const p of parts) {
      const [k, v] = p.split(':').map(x => x.trim());
      out[k] = parseFloat(v);
    }
    if (['sharpness', 'exposure', 'face', 'tags'].every(k => typeof out[k] === 'number')) {
      return out as Weights;
    }
  } catch {}
  return null;
}

function albumDisplayName(a: Album): string {
  return a.albumName || a.name || '';
}

// ===== Immich API =====
async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  const { data } = await api.get('/api/duplicates');
  return Array.isArray(data) ? data : [];
}

async function listAlbums(): Promise<Album[]> {
  const { data } = await api.get('/api/albums');
  return Array.isArray(data) ? data : [];
}

async function getOrCreateAlbumByName(name: string): Promise<Album> {
  const albums = await listAlbums();
  const found = albums.find(a => albumDisplayName(a) === name);
  if (found) return found;
  const { data } = await api.post('/api/albums', { albumName: name });
  return data;
}

async function addAssetsToAlbum(albumId: string, ids: string[]) {
  if (!ids.length) return;
  try {
    const { data } = await api.put(`/api/albums/${albumId}/assets`, { ids });
    if (Array.isArray(data)) {
      const ok = data.filter((r: any) => r?.success).length;
      const fails = data.filter((r: any) => !r?.success);
      if (fails.length) {
        console.warn(`Album ${albumId}: added ${ok}/${data.length}; failures: ` +
          fails.map((f: any) => `${f?.id}:${f?.error || 'unknown'}`).join(', '));
      } else {
        console.log(`Album ${albumId}: added ${ok}/${data.length} assets`);
      }
    } else {
      console.log(`Album ${albumId}: response`, data);
    }
  } catch (e: any) {
    console.error(`Album ${albumId}: add-assets failed:`, e?.response?.data || e?.message || e);
  }
}

// Fetch a single asset (for smartInfo)
async function getAsset(assetId: string): Promise<Asset | null> {
  try {
    const { data } = await api.get(`/api/assets/${assetId}`);
    return data as Asset;
  } catch (e: any) {
    console.warn(`getAsset(${assetId}) failed:`, e?.response?.status, e?.response?.data || e?.message);
    return null;
  }
}

// Try multiple preview routes for compatibility
async function getPreviewBytes(assetId: string): Promise<Buffer | null> {
  const paths = [
    `/api/assets/${assetId}/thumbnail?size=${encodeURIComponent(THUMBNAIL_SIZE)}`,
    `/api/assets/${assetId}/thumbnail`,
    `/api/assets/${assetId}/preview` // older builds
  ];
  for (const p of paths) {
    try {
      const resp = await api.get(p, { responseType: 'arraybuffer', maxContentLength: THUMBNAIL_MAX_BYTES });
      return Buffer.from(resp.data);
    } catch (e: any) {
      const code = e?.response?.status;
      if (code && code !== 404) {
        // non-404 likely permission or other error; log and stop trying
        console.warn(`Preview fetch failed for ${assetId} at ${p}:`, e?.response?.data || e?.message);
        return null;
      }
      // else try next
    }
  }
  return null;
}

// ===== Image metrics =====

// Convert JPEG bytes to {width,height, data: RGBA}
function decodeJpeg(buf: Buffer): { width: number; height: number; data: Uint8Array } | null {
  try {
    const img = jpeg.decode(buf, { useTArray: true });
    if (!img || !img.width || !img.height) return null;
    return img as any;
  } catch {
    return null;
  }
}

// Fast grayscale from RGBA
function toGrayscaleRGBA(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length / 4);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 1) {
    const r = src[i], g = src[i + 1], b = src[i + 2];
    out[j] = (r * 299 + g * 587 + b * 114) / 1000; // ITU-R BT.601
  }
  return out;
}

// Variance of Laplacian (3x3)
function varianceOfLaplacian(gray: Uint8Array, width: number, height: number): number {
  const kernel = [0, 1, 0, 1, -4, 1, 0, 1, 0];
  const conv = new Float32Array(width * height);
  let idx = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p0 = (y - 1) * width + (x - 1);
      const p1 = p0 + 1;
      const p2 = p0 + 2;
      const p3 = p0 + width;
      const p4 = p3 + 1;
      const p5 = p3 + 2;
      const p6 = p0 + 2 * width;
      const p7 = p6 + 1;
      const p8 = p6 + 2;
      const val =
        gray[p0] * kernel[0] + gray[p1] * kernel[1] + gray[p2] * kernel[2] +
        gray[p3] * kernel[3] + gray[p4] * kernel[4] + gray[p5] * kernel[5] +
        gray[p6] * kernel[6] + gray[p7] * kernel[7] + gray[p8] * kernel[8];
      conv[idx++] = val;
    }
  }
  // compute variance
  const n = conv.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += conv[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = conv[i] - mean;
    variance += d * d;
  }
  variance /= n;
  return variance;
}

// Exposure metrics: mean luminance + clipped fraction
function exposureScore(gray: Uint8Array): number {
  const n = gray.length;
  let sum = 0, clippedLow = 0, clippedHigh = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    sum += v;
    if (v <= 3) clippedLow++;
    if (v >= 252) clippedHigh++;
  }
  const mean = sum / n;               // ideal ~ 110-150 for previews
  const normMean = 1 - Math.abs((mean - 130) / 130); // map 0..255 -> prefer mid
  const clipFrac = (clippedLow + clippedHigh) / n;
  const clipPenalty = 1 - Math.min(1, clipFrac * 5); // heavy penalty if many clipped
  const score = Math.max(0, Math.min(1, 0.6 * Math.max(0, normMean) + 0.4 * clipPenalty));
  return score;
}

// Simple composition: reward central information density
function compositionScore(gray: Uint8Array, width: number, height: number): number {
  // Divide into 3x3 grid; compare center block energy vs edges
  const grid = 3;
  const gw = Math.floor(width / grid);
  const gh = Math.floor(height / grid);
  let centerSum = 0, totalSum = 0;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      let cell = 0;
      for (let y = gy * gh; y < (gy + 1) * gh; y++) {
        for (let x = gx * gw; x < (gx + 1) * gw; x++) {
          cell += gray[y * width + x];
        }
      }
      totalSum += cell;
      if (gx === 1 && gy === 1) centerSum = cell; // center cell
    }
  }
  if (totalSum === 0) return 0.5;
  const centerFrac = centerSum / totalSum; // higher is better (some subject near middle)
  // Normalize roughly: centerFrac ~ 0.11 for uniform image in 3x3; map to 0..1
  const score = Math.max(0, Math.min(1, (centerFrac - 0.11) / (0.35 - 0.11)));
  return score;
}

// Face/tags score from Immich smartInfo
function smartInfoScore(asset: Asset): { face: number; tags: number } {
  let faceCount = 0;
  if (asset.smartInfo?.people && Array.isArray(asset.smartInfo.people)) {
    faceCount = asset.smartInfo.people.length;
  } else if (asset.smartInfo?.faces && Array.isArray(asset.smartInfo.faces)) {
    faceCount = asset.smartInfo.faces.length;
  }
  const faceScore = Math.min(1, faceCount / 3); // cap at 3 faces

  const tags = (asset.smartInfo?.tags || []).map(t => (t || '').toString().toLowerCase());
  let tagBoost = 0;
  const positive = ['person', 'people', 'portrait', 'family', 'selfie'];
  const negative = ['screenshot', 'document', 'whiteboard', 'qr', 'barcode'];
  if (tags.some(t => positive.includes(t))) tagBoost += 0.7;
  if (tags.some(t => negative.includes(t))) tagBoost -= 0.6;
  tagBoost = Math.max(-1, Math.min(1, tagBoost));
  const tagScore = (tagBoost + 1) / 2; // map -1..1 -> 0..1

  return { face: faceScore, tags: tagScore };
}

// Compute hybrid score for an asset id
async function scoreAsset(assetId: string): Promise<{ score: number; parts: any }> {
  // Fetch preview
  const bytes = await getPreviewBytes(assetId);
  if (!bytes) {
    return { score: 0, parts: { reason: 'no_preview' } };
  }
  const decoded = decodeJpeg(bytes);
  if (!decoded) {
    return { score: 0, parts: { reason: 'decode_failed' } };
  }
  const { width, height, data } = decoded;
  const gray = toGrayscaleRGBA(data);

  const sharpVar = varianceOfLaplacian(gray, width, height);
  // Normalize sharpness variance to 0..1 by log scaling
  const sharp = Math.max(0, Math.min(1, Math.log10(1 + sharpVar) / 5));

  const exposure = exposureScore(gray);
  const composition = compositionScore(gray, width, height);

  let face = 0, tags = 0;
  if (USE_IMMICH_AI) {
    const a = await getAsset(assetId);
    if (a) {
      const s = smartInfoScore(a);
      face = s.face;
      tags = s.tags;
    }
  }

  // Blend (composition folded into exposure weight to stay within 4 weights)
  const exposureComposite = Math.max(0, Math.min(1, 0.75 * exposure + 0.25 * composition));

  const score =
    SCORING_WEIGHTS.sharpness * sharp +
    SCORING_WEIGHTS.exposure * exposureComposite +
    SCORING_WEIGHTS.face * face +
    SCORING_WEIGHTS.tags * tags;

  return { score, parts: { sharp, exposure: exposureComposite, face, tags } };
}

// Pick best by score
async function pickBestByScore(assetIds: string[]): Promise<{ best: string; others: string[]; debug: any[] }> {
  const results: Array<{ id: string; total: number; parts: any }> = [];
  for (const id of assetIds) {
    const s = await scoreAsset(id);
    results.push({ id, total: s.score, parts: s.parts });
  }
  results.sort((a, b) => b.total - a.total);
  const best = results[0].id;
  const others = results.slice(1).map(r => r.id);
  return { best, others, debug: results };
}

// ===== Normal actions =====
async function bulkFavorite(ids: string[]) {
  if (!ids.length) return;
  await api.put('/api/assets', { ids, isFavorite: true });
}

async function bulkHide(ids: string[]) {
  if (!ids.length) return;
  await api.put('/api/assets', { ids, visibility: 'hidden' });
}

async function deleteDuplicateGroup(groupId: string) {
  await api.delete(`/api/duplicates/${groupId}`);
}

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

// ===== Review album actions =====
async function applyReviewAlbumActions(
  winnersAlbumId: string,
  alternatesAlbumId: string,
  bestId: string,
  others: string[],
) {
  console.log(`Review mode: add winner ${bestId} -> "${WINNERS_ALBUM_NAME}", alternates (${others.length}) -> "${ALTERNATES_ALBUM_NAME}"`);
  if (!APPLY_CHANGES) return;
  await addAssetsToAlbum(winnersAlbumId, [bestId]);
  await addAssetsToAlbum(alternatesAlbumId, others);
}

// ===== Main =====
async function main() {
  console.log('Best Shot Selector (Hybrid) starting…');
  console.log(
    `Flags ⇒ REVIEW_ALBUM_MODE=${REVIEW_ALBUM_MODE} REVIEW_ALBUM_LIMIT=${REVIEW_ALBUM_LIMIT} BESTSHOT_ACTION=${BESTSHOT_ACTION} APPLY_CHANGES=${APPLY_CHANGES} USE_IMMICH_AI=${USE_IMMICH_AI}`
  );
  console.log(`Weights ⇒ ${JSON.stringify(SCORING_WEIGHTS)}`);

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
      const winners = await getOrCreateAlbumByName(WINNERS_ALBUM_NAME);
      const alternates = await getOrCreateAlbumByName(ALTERNATES_ALBUM_NAME);
      winnersAlbumId = winners.id;
      alternatesAlbumId = alternates.id;

      console.log(`Review mode ON (limit ${REVIEW_ALBUM_LIMIT}). Winners="${albumDisplayName(winners)}", Alternates="${albumDisplayName(alternates)}".`);
    } else {
      console.log(`Normal mode ON. BESTSHOT_ACTION=${BESTSHOT_ACTION}`);
    }

    const slice = REVIEW_ALBUM_MODE ? groups.slice(0, REVIEW_ALBUM_LIMIT) : groups;
    let processed = 0;

    for (const g of slice) {
      const assetIds = (g.assets ?? []).map(a => a.id).filter(Boolean);
      if (!assetIds.length) {
        console.log(`Group ${g.duplicateId}: no assets, skipping`);
        continue;
      }

      const { best, others, debug } = await pickBestByScore(assetIds);
      const parts = debug.find(d => d.id === best)?.parts;
      console.log(`Group ${g.duplicateId}: best=${best}, others=${others.length} score=${(debug.find(d=>d.id===best)?.total||0).toFixed(3)} parts=${JSON.stringify(parts)}`);

      if (REVIEW_ALBUM_MODE && winnersAlbumId && alternatesAlbumId) {
        await applyReviewAlbumActions(winnersAlbumId, alternatesAlbumId, best, others);
      } else {
        await applyNormalActions(g, best, others);
      }
      processed++;
    }

    console.log(`Done. Mode=${REVIEW_ALBUM_MODE ? 'review-albums' : BESTSHOT_ACTION} Apply=${APPLY_CHANGES} Processed=${processed}`);
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
