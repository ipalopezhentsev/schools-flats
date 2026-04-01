require('dotenv').config();
const { load } = require('cheerio');
const { writeFileSync } = require('fs');

const RATINGS_URL =
  'https://www.krylatskoye.ru/content/ratings/2025/08/rejting-shkol-moskvy-2025.html';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_UA = 'schools-flats-map/1.0';

const KINDER_RE = /д\/с|дошкольн|детский\s+сад|ясл/i;

const GROUP_COLORS = {
  1: '#1a9641',
  2: '#a6d96a',
  3: '#fdae61',
  4: '#f17c4a',
  5: '#d7191c',
  6: '#2b83ba',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function parseSchools(html) {
  const $ = load(html);
  const groups = [];
  const schools = [];

  $('h2').each((_, h2El) => {
    const text = $(h2El).text().trim();
    const m = text.match(/Группа\s*№\s*(\d+)/);
    if (!m) return;

    const groupId = parseInt(m[1], 10);
    groups.push({ id: groupId, label: text, color: GROUP_COLORS[groupId] ?? '#888888' });

    const table = $(h2El).nextAll('div.table_width').first().find('table');
    table.find('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 1) return;

      const name = $(tds[0]).text().trim();
      const district = tds.length > 1 ? $(tds[1]).text().trim() : '';
      const okrug = tds.length > 2 ? $(tds[2]).text().trim() : '';
      if (!name) return;

      const numMatch = name.match(/№\s*(\d+)/);
      const number = numMatch ? numMatch[1] : null;
      schools.push({ name, number, district, okrug, groupId, buildings: [] });
    });
  });

  return { groups, schools };
}

// Amenity name variants to try in structured Nominatim queries.
// OSM data may use different school type names and may or may not include the № sign.
const SCHOOL_AMENITY_VARIANTS = (number) => [
  `школа ${number}`,
  `школа №${number}`,
  `гимназия ${number}`,
  `гимназия №${number}`,
  `лицей ${number}`,
  `лицей №${number}`,
];

async function nominatimFetch(params) {
  const urlParams = new URLSearchParams({ format: 'json', countrycodes: 'ru', limit: '10', ...params });
  const res = await fetch(`${NOMINATIM_BASE}?${urlParams}`, {
    headers: { 'User-Agent': NOMINATIM_UA },
  });
  if (!res.ok) {
    console.warn(`  Nominatim HTTP ${res.status}`);
    return [];
  }
  return res.json();
}

function filterResults(results, school) {
  const buildings = [];
  for (const r of results) {
    const name = r.display_name ?? '';
    if (!name.includes('Москва')) continue;
    if (KINDER_RE.test(name)) continue;
    if (school.number && !name.includes(school.number)) continue;
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    if (isNaN(lat) || isNaN(lon)) continue;
    const parts = name.split(', ');
    buildings.push({ name: parts[0], address: name, lat, lon });
  }
  return buildings;
}

async function geocodeSchool(school) {
  // Strategy 1: structured amenity queries for numbered schools.
  // These find schools regardless of whether OSM uses "школа", "гимназия", etc.
  if (school.number) {
    const variants = SCHOOL_AMENITY_VARIANTS(school.number);
    for (let i = 0; i < variants.length; i++) {
      if (i > 0) await sleep(1100);
      const results = await nominatimFetch({ amenity: variants[i], city: 'Москва' });
      const buildings = filterResults(results, school);
      if (buildings.length > 0) return buildings;
    }
  }

  // Strategy 2: free-text fallback using full name from ratings page.
  if (school.number) await sleep(1100);
  const query = `${school.name} Москва`;
  const results = await nominatimFetch({ q: query });
  return filterResults(results, school);
}

async function main() {
  console.log('Fetching ratings page...');
  const html = await fetchPage(RATINGS_URL);

  console.log('Parsing schools...');
  const { groups, schools } = parseSchools(html);
  console.log(`Found ${groups.length} groups, ${schools.length} schools\n`);

  console.log('Geocoding via Nominatim (this takes ~7 minutes)...');
  for (let i = 0; i < schools.length; i++) {
    const school = schools[i];
    process.stdout.write(`  [${i + 1}/${schools.length}] ${school.name} ... `);
    school.buildings = await geocodeSchool(school);
    console.log(`${school.buildings.length} buildings`);
    if (i < schools.length - 1) await sleep(1100); // Nominatim: max 1 req/sec
  }

  const output = { groups, schools };

  writeFileSync('schools.json', JSON.stringify(output, null, 2), 'utf8');
  writeFileSync('data.js', `window.SCHOOLS_DATA = ${JSON.stringify(output)};\n`, 'utf8');

  const totalBuildings = schools.reduce((s, sc) => s + sc.buildings.length, 0);
  const noBuildings = schools.filter((sc) => sc.buildings.length === 0);

  const groupById = Object.fromEntries(groups.map((g) => [g.id, g]));
  const notFound = noBuildings.map((sc) => ({
    name: sc.name,
    number: sc.number,
    district: sc.district,
    okrug: sc.okrug,
    groupId: sc.groupId,
    groupLabel: groupById[sc.groupId]?.label ?? '',
  }));
  writeFileSync('not_found.json', JSON.stringify(notFound, null, 2), 'utf8');

  console.log(`\nDone! ${totalBuildings} buildings across ${schools.length} schools.`);
  console.log(`Found: ${schools.length - noBuildings.length}/${schools.length} schools geocoded.`);
  console.log(`Not found: ${noBuildings.length}/${schools.length} schools.`);
  if (noBuildings.length > 0) {
    noBuildings.forEach((sc) => console.log(`  - ${sc.name}`));
  }
  console.log('Written: schools.json, data.js, not_found.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
