// bake.js — nightly pull of the safari.com affiliate catalogue.
// Reads SAFARI_TOKEN from the environment; writes safari-catalogue.json.
// v1: full safari list + taxonomies. Rate-period detail comes in v2.

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

// The docs don't name the array key in list responses, so find it.
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
    const qs = cursor == null ? '?limit=200' : '?limit=200&cursor=' + cursor;
    const payload = await get('/api/affiliate/safaris' + qs);
    const batch = extractArray(payload);
    all.push(...batch);
    console.log('page ' + (page + 1) + ': ' + batch.length + ' safaris (running total ' + all.length + ')');
    cursor = payload ? payload.nextCursor : null;
    if (cursor == null || batch.length === 0) break;
    await sleep(300); // politeness between pages
  }
  return all;
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

  const catalogue = {
    generated: new Date().toISOString(),
    source: 'safari.com affiliate API',
    counts: {
      safaris: safaris.length,
      destinations: destinations.length,
      brands: brands.length,
      experiences: experiences.length,
    },
    destinations,
    brands,
    experiences,
    safaris,
  };

  fs.writeFileSync('safari-catalogue.json', JSON.stringify(catalogue, null, 1));
  console.log('Wrote safari-catalogue.json: ' + safaris.length + ' safaris, ' +
    brands.length + ' brands, ' + destinations.length + ' destinations.');
})().catch((err) => {
  console.error('Bake failed:', err.message);
  process.exit(1);
});
