// bake.js v2 — nightly pull of the safari.com affiliate catalogue.
// v2: all prices normalised to USD (?currency=USD), plus a brandIndex
// mapping each operator slug to its bookable safaris via the server-side
// brand filter — powers the operator review page modules.

const fs = require('fs');

const BASE = 'https://www.safari.com';
const TOKEN = process.env.SAFARI_TOKEN;

if (!TOKEN) {
  console.error('SAFARI_TOKEN is not set — add it under Settings > Secrets > Actions.');
  process.exit(1);
}

const HEADERS = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, attempt = 1) {
  const res = await fetch(BASE + path, { headers: HEADERS });
  if (res.status >= 500 && attempt < 3) {
    await sleep(1000 * attempt);
    return get(path, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(res.status + ' on ' + path + ': ' + body.slice(0, 300));
  }
  return res.json();
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['safaris', 'items', 'results', 'data', 'destinations', 'experiences']) {
    if (Array.isArray(payload && payload[key])) return payload[key];
  }
  const arr = Object.values(payload || {}).find(Array.isArray);
  return arr || [];
}

async function fetchAllSafaris() {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const qs = '?limit=200&currency=USD' + (cursor == null ? '' : '&cursor=' + cursor);
    const payload = await get('/api/affiliate/safaris' + qs);
    const batch = extractArray(payload);
    all.push(...batch);
    console.log('page ' + (page + 1) + ': ' + batch.length + ' safaris (running total ' + all.length + ')');
    cursor = payload ? payload.nextCursor : null;
    if (cursor == null || batch.length === 0) break;
    await sleep(300);
  }
  return all;
}

async function fetchBrandIndex(brands, knownSlugs) {
  const index = {};
  const extras = [];
  for (const b of brands) {
    try {
      const payload = await get('/api/affiliate/safaris?limit=200&currency=USD&brand=' + encodeURIComponent(b.slug));
      const batch = extractArray(payload);
      index[b.slug] = batch.map((s) => s.slug);
      for (const s of batch) {
        if (!knownSlugs.has(s.slug)) { knownSlugs.add(s.slug); extras.push(s); }
      }
      console.log('brand ' + b.slug + ': ' + batch.length + ' safaris');
    } catch (err) {
      console.log('brand ' + b.slug + ' failed: ' + err.message);
      index[b.slug] = [];
    }
    await sleep(250);
  }
  return { index, extras };
}

(async () => {
  const destinations = extractArray(await get('/api/affiliate/destinations?kind=destination'));
  const brands = extractArray(await get('/api/affiliate/destinations?kind=brand'));
  const experiences = extractArray(await get('/api/affiliate/experiences'));
  const safaris = await fetchAllSafaris();

  if (safaris.length === 0) {
    console.error('Zero safaris returned — refusing to publish an empty catalogue.');
    process.exit(1);
  }

  const knownSlugs = new Set(safaris.map((s) => s.slug));
  const { index: brandIndex, extras } = await fetchBrandIndex(brands, knownSlugs);
  safaris.push(...extras);
  if (extras.length) console.log('brand queries surfaced ' + extras.length + ' additional safaris');

  const catalogue = {
    generated: new Date().toISOString(),
    source: 'safari.com affiliate API',
    counts: {
      safaris: safaris.length,
      destinations: destinations.length,
      brands: brands.length,
      experiences: experiences.length,
    },
    brandIndex,
    destinations,
    brands,
    experiences,
    safaris,
  };

  fs.writeFileSync('safari-catalogue.json', JSON.stringify(catalogue, null, 1));
  console.log('Wrote safari-catalogue.json: ' + safaris.length + ' safaris (USD), ' +
    brands.length + ' brands indexed, ' + destinations.length + ' destinations.');
})().catch((err) => {
  console.error('Bake failed:', err.message);
  process.exit(1);
});
