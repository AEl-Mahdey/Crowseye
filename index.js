require('dotenv').config();
const express = require('express');
const { DomeClient } = require('@dome-api/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const dome = new DomeClient({ apiKey: process.env.DOME_API_KEY });

// Countries that use a different tag than their full name on Polymarket
const POLY_TAG_MAP = {
  'united states of america': null,   // no country tag — use title search
  'united states':            null,
  'united kingdom':           'UK',
  'great britain':            'UK',
  'south korea':              'Korea',
  'north korea':              'Korea',
  'democratic republic of the congo': 'Congo',
  'republic of the congo':    'Congo',
  'czech republic':           'Czech',
  'russia':                   'Russia',
};

// Keywords to match in titles when a country has no Polymarket tag
const TITLE_KEYWORDS = {
  'united states of america': ['united states', ' u.s.', 'american', 'america', 'trump', 'federal reserve', 'congress', 'senate', 'white house'],
  'united states':            ['united states', ' u.s.', 'american', 'america', 'trump', 'federal reserve', 'congress', 'senate', 'white house'],
};

function getPolyTag(country) {
  const key = country.toLowerCase();
  if (key in POLY_TAG_MAP) return POLY_TAG_MAP[key]; // null = no tag
  return country; // use full name as tag by default
}

function getTitleKeywords(country) {
  return TITLE_KEYWORDS[country.toLowerCase()] ?? [country.toLowerCase()];
}

async function fetchPolymarkets(country) {
  const tag = getPolyTag(country);

  if (tag !== null) {
    // Use tag filter (fast & accurate)
    const res = await dome.polymarket.markets.getMarkets({ status: 'open', tags: tag, limit: 20 });
    return (res?.markets ?? [])
      .sort((a, b) => (b.volume_total ?? 0) - (a.volume_total ?? 0))
      .map(m => ({
        title: m.title,
        volume: m.volume_total,
        url: `https://polymarket.com/event/${m.event_slug}`,
        platform: 'Polymarket',
      }));
  }

  // No tag available — paginate and search titles
  const keywords = getTitleKeywords(country);
  const matched = [];
  let paginationKey;

  for (let page = 0; page < 5 && matched.length < 15; page++) {
    const res = await dome.polymarket.markets.getMarkets({
      status: 'open', limit: 100, ...(paginationKey ? { pagination_key: paginationKey } : {}),
    });
    const markets = res?.markets ?? [];

    for (const m of markets) {
      const title = m.title?.toLowerCase() ?? '';
      if (keywords.some(k => title.includes(k))) matched.push(m);
    }

    if (!res?.pagination?.has_more) break;
    paginationKey = res?.pagination?.pagination_key;
  }

  return matched
    .sort((a, b) => (b.volume_total ?? 0) - (a.volume_total ?? 0))
    .slice(0, 15)
    .map(m => ({
      title: m.title,
      volume: m.volume_total,
      url: `https://polymarket.com/event/${m.event_slug}`,
      platform: 'Polymarket',
    }));
}

async function fetchKalshiMarkets(country) {
  const keywords = getTitleKeywords(country);
  const matched = [];
  let paginationKey;

  // Paginate up to 3 pages (300 markets) to find country matches
  for (let page = 0; page < 3 && matched.length < 15; page++) {
    const res = await dome.kalshi.markets.getMarkets({
      status: 'open', limit: 100, ...(paginationKey ? { pagination_key: paginationKey } : {}),
    });
    const markets = res?.markets ?? [];

    for (const m of markets) {
      const title = m.title?.toLowerCase() ?? '';
      if (keywords.some(k => title.includes(k))) matched.push(m);
    }

    if (!res?.pagination?.has_more) break;
    paginationKey = res?.pagination?.pagination_key;
  }

  return matched
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 15)
    .map(m => ({
      title: m.title,
      volume: m.volume,
      url: `https://kalshi.com/markets/${m.event_ticker}`,
      platform: 'Kalshi',
    }));
}

app.get('/api/markets/:country', async (req, res) => {
  const country = req.params.country;
  try {
    const [polymarkets, kalshiMarkets] = await Promise.all([
      fetchPolymarkets(country),
      fetchKalshiMarkets(country),
    ]);
    res.json({ country, polymarkets, kalshiMarkets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
