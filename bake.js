// bake.js v3 — nightly pull of the safari.com affiliate catalogue.
// v3: native currencies restored (their ?currency=USD filters rather than
// converts); nightly FX rate stamps priceFromUsd on every safari for one
// comparable price column; operator index derived from lodge ownership,
// replacing their broken server-side brand filter; special-price sanity.

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
    const qs = '?limit=200' + (cursor == null ? '' : '&cursor=' + cursor);
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

async function fetchZarRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    const rate = data && data.rates && data.rates.ZAR;
    if (rate && rate > 5 && rate < 60) return { zarPerUsd: rate, source: 'open.er-api.com' };
  } catch (err) {
    console.log('FX fetch failed: ' + err.message);
  }
  console.log('Using fallback ZAR rate');
  return { zarPerUsd: 18.0, source: 'fallback-static' };
}

// Operator index: lodge ownership + name matching. Ours, so it cannot break upstream.
const OPERATORS = {
  'singita':             { prefixes: ['singita'], text: ['singita'] },
  'andbeyond':           { lodges: ['ngala', 'ngala-tented', 'phinda-forest', 'phinda-vlei', 'phinda-zuka', 'kichwa-tembo', 'bateleur', 'tengile-river', 'kirkmans-kamp', 'chobe-under-canvas', 'serengeti-under-canvas', 'lake-manyara-tree'], text: ['andbeyond', '&beyond'] },
  'londolozi':           { prefixes: ['londolozi'] },
  'sanctuary-retreats':  { lodges: ['sussi-chuma', 'chobe-chilwero', 'chiefs'] },
  'wilderness':          { lodges: ['damaraland-camp', 'kings-pool'] },
  'tswalu-kalahari':     { lodges: ['tswalu-kalahari'], text: ['tswalu'] },
  'natural-selection':   { lodges: ['jacks'] },
  'african-bush-camps':  { lodges: ['linyanti-bush-camp', 'khwai-lediba'] },
  'belmond':             { lodges: ['mount-nelson', 'savute-elephant', 'eagle-island'], text: ['belmond'] },
  'lion-sands':          { prefixes: ['lion-sands'] },
  'sabi-sabi':           { prefixes: ['sabi-sabi'] },
  'mala-mala':           { lodges: ['mala-mala-camp'] },
  'kapama':              { prefixes: ['kapama'] },
  'ulusaba':             { prefixes: ['ulusaba'] },
};

function matchesOperator(safari, rules) {
  const lodges = safari.lodges || [];
  const text = (safari.name + ' ' + (safari.summary || '') + ' ' +
    (safari.highlights || []).join(' ')).toLowerCase();
  if (rules.prefixes && lodges.some((l) => rules.prefixes.some((p) => l.startsWith(p)))) return true;
  if (rules.lodges && lodges.some((l) => rules.lodges.includes(l))) return true;
  if (rules.text && rules.text.some((t) => text.includes(t))) return true;
  return false;
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

  const fx = await fetchZarRate();

  for (const s of safaris) {
    // Special-price sanity: a "special" that isn't cheaper is noise.
    if (s.priceFromSpecial != null && s.priceFrom != null && s.priceFromSpecial >= s.priceFrom) {
      s.priceFromSpecial = null;
    }
    const toUsd = (v) => {
      if (v == null) return null;
      if (s.currency === 'USD') return Math.round(v);
      if (s.currency === 'ZAR') return Math.round(v / fx.zarPerUsd / 10) * 10;
      return null;
    };
    s.priceFromUsd = toUsd(s.priceFrom);
    s.priceFromSpecialUsd = toUsd(s.priceFromSpecial);
  }

  const brandIndex = {};
  for (const [slug, rules] of Object.entries(OPERATORS)) {
    brandIndex[slug] = safaris.filter((s) => matchesOperator(s, rules)).map((s) => s.slug);
    console.log('operator ' + slug + ': ' + brandIndex[slug].length + ' safaris');
  }

  const catalogue = {
    generated: new Date().toISOString(),
    source: 'safari.com affiliate API',
    fx: { zarPerUsd: fx.zarPerUsd, source: fx.source, note: 'ZAR prices converted to approximate USD at bake time' },
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
  console.log('Wrote safari-catalogue.json: ' + safaris.length + ' safaris, FX ' +
    fx.zarPerUsd.toFixed(2) + ' ZAR/USD (' + fx.source + ').');
})().catch((err) => {
  console.error('Bake failed:', err.message);
  process.exit(1);
});
