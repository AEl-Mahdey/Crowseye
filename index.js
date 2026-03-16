require('dotenv').config();
const express = require('express');
const { DomeClient } = require('@dome-api/sdk');
const OpenAI = require('openai').default;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const dome = new DomeClient({ apiKey: process.env.DOME_API_KEY });
const routellm = new OpenAI({
  apiKey: process.env.ABACUS_API_KEY,
  baseURL: 'https://routellm.abacus.ai/v1',
});

const POLY_TAG_MAP = {
  'united states of america': null,
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

const TITLE_KEYWORDS = {
  'united states of america': ['united states', ' u.s.', 'american', 'america', 'trump', 'federal reserve', 'congress', 'senate', 'white house'],
  'united states':            ['united states', ' u.s.', 'american', 'america', 'trump', 'federal reserve', 'congress', 'senate', 'white house'],
};

function getPolyTag(country) {
  const key = country.toLowerCase();
  return key in POLY_TAG_MAP ? POLY_TAG_MAP[key] : country;
}

function getTitleKeywords(country) {
  return TITLE_KEYWORDS[country.toLowerCase()] ?? [country.toLowerCase()];
}

function mapPoly(m) {
  return {
    title:          m.title,
    volume:         m.volume_total,
    volume_week:    m.volume_1_week ?? 0,
    start_time:     m.start_time ?? 0,
    url:            `https://polymarket.com/event/${m.event_slug}`,
    platform:       'Polymarket',
  };
}

function mapKalshi(m) {
  return {
    title:          m.title,
    volume:         m.volume,
    volume_week:    m.volume_24h ?? 0,
    start_time:     m.start_time ?? 0,
    last_price:     m.last_price ?? null,
    url:            `https://kalshi.com/markets/${m.event_ticker}`,
    platform:       'Kalshi',
  };
}

// Fetch one page of Polymarket markets for a country
async function fetchPolyPage(country, cursor) {
  const tag = getPolyTag(country);

  if (tag !== null) {
    // Tag-based: single fast call, no pagination needed
    const res = await dome.polymarket.markets.getMarkets({ status: 'open', tags: tag, limit: 20 });
    const markets = (res?.markets ?? []).sort((a, b) => (b.volume_total ?? 0) - (a.volume_total ?? 0)).map(mapPoly);
    return { markets, nextCursor: null };
  }

  // Title-search fallback: fetch one page and filter
  const keywords = getTitleKeywords(country);
  const res = await dome.polymarket.markets.getMarkets({
    status: 'open', limit: 100, ...(cursor ? { pagination_key: cursor } : {}),
  });
  const markets = (res?.markets ?? [])
    .filter(m => keywords.some(k => m.title?.toLowerCase().includes(k)))
    .sort((a, b) => (b.volume_total ?? 0) - (a.volume_total ?? 0))
    .map(mapPoly);

  return { markets, nextCursor: res?.pagination?.has_more ? res.pagination.pagination_key : null };
}

// Fetch one page of Kalshi markets for a country
async function fetchKalshiPage(country, cursor) {
  const keywords = getTitleKeywords(country);
  let allMarkets = [];
  let nextCursor = cursor;
  for (let i = 0; i < 5; i++) {
    const res = await dome.kalshi.markets.getMarkets({
      status: 'open', limit: 200, ...(nextCursor ? { pagination_key: nextCursor } : {}),
    });
    const markets = res?.markets ?? [];
    allMarkets = allMarkets.concat(markets);
    const matches = allMarkets.filter(m => keywords.some(k => m.title?.toLowerCase().includes(k)));
    if (matches.length >= 15 || !res?.pagination?.has_more) {
      nextCursor = res?.pagination?.has_more ? res.pagination.pagination_key : null;
      break;
    }
    nextCursor = res.pagination.pagination_key;
  }
  const markets = allMarkets
    .filter(m => keywords.some(k => m.title?.toLowerCase().includes(k)))
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .map(mapKalshi);

  return { markets, nextCursor };
}

app.get('/api/markets/:country', async (req, res) => {
  const country = req.params.country;
  const polyCursor = req.query.poly_cursor || null;
  const kalshiCursor = req.query.kalshi_cursor || null;

  try {
    const [polyResult, kalshiResult] = await Promise.all([
      fetchPolyPage(country, polyCursor),
      fetchKalshiPage(country, kalshiCursor),
    ]);

    res.json({
      country,
      polymarkets:   polyResult.markets,
      kalshiMarkets: kalshiResult.markets,
      nextCursors: {
        poly:   polyResult.nextCursor,
        kalshi: kalshiResult.nextCursor,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Markets search by free-text query
app.get('/api/search-markets', async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const keywords = [query.toLowerCase()];

  try {
    const [polyResult, kalshiResult] = await Promise.allSettled([
      dome.polymarket.markets.getMarkets({ status: 'open', tags: query, limit: 20 }),
      (async () => {
        // Paginate Kalshi until we have 15+ matches or run out of pages (max 5 pages)
        let allMarkets = [];
        let cursor = undefined;
        for (let i = 0; i < 5; i++) {
          const page = await dome.kalshi.markets.getMarkets({
            status: 'open', limit: 200, ...(cursor ? { pagination_key: cursor } : {}),
          });
          const markets = page?.markets ?? [];
          allMarkets = allMarkets.concat(markets);
          const matches = allMarkets.filter(m => keywords.some(k => m.title?.toLowerCase().includes(k)));
          if (matches.length >= 15 || !page?.pagination?.has_more) break;
          cursor = page.pagination.pagination_key;
        }
        return { markets: allMarkets };
      })(),
    ]);

    // Polymarket: tag-based result; if empty fall back to title search
    let polymarkets = polyResult.status === 'fulfilled'
      ? (polyResult.value?.markets ?? []) : [];

    if (polymarkets.length === 0) {
      // Title search fallback — fetch one page
      const fallback = await dome.polymarket.markets.getMarkets({ status: 'open', limit: 100 });
      polymarkets = (fallback?.markets ?? [])
        .filter(m => keywords.some(k => m.title?.toLowerCase().includes(k)));
    }

    polymarkets = polymarkets
      .sort((a, b) => (b.volume_total ?? 0) - (a.volume_total ?? 0))
      .slice(0, 15)
      .map(mapPoly);

    const kalshiMarkets = kalshiResult.status === 'fulfilled'
      ? (kalshiResult.value?.markets ?? [])
          .filter(m => keywords.some(k => m.title?.toLowerCase().includes(k)))
          .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
          .slice(0, 15)
          .map(mapKalshi)
      : [];

    res.json({ query, polymarkets, kalshiMarkets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streaming search via RouteLLM
app.get('/api/search', async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.status(400).json({ error: 'Missing query' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await routellm.chat.completions.create({
      model: 'route-llm',
      max_tokens: 1024,
      stream: true,
      messages: [
        {
          role: 'system',
          content: `You are a financial due diligence assistant. Given a query, return a 2-3 sentence investor snapshot — what the company or asset does, its current market position, and the single biggest risk or opportunity right now. Be direct and concise. No bullet points, no headers, no markdown. If the query is not finance-related, politely redirect the user.`,
        },
        { role: 'user', content: `Due diligence query: ${query}` },
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

app.get('/map', (req, res) => {
  res.sendFile('map.html', { root: 'public' });
});

// News-based sentiment analysis
app.get('/api/sentiment/:query', async (req, res) => {
  const query = req.params.query;
  const key = process.env.NEWS_API_KEY;

  // 1. Fetch recent news articles via NewsAPI
  const newsRes = await fetch(
    `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=relevancy&searchIn=title,description&pageSize=20&apiKey=${key}`
  );

  if (!newsRes.ok) {
    return res.status(502).json({ error: 'Failed to fetch news articles' });
  }

  const newsData = await newsRes.json();
  if (newsData.status !== 'ok') {
    return res.status(502).json({ error: newsData.message || 'NewsAPI error' });
  }

  const articles = (newsData.articles ?? [])
    .filter(a => a.title && !a.title.includes('[Removed]'))
    .slice(0, 20)
    .map(a => ({
      title:       a.title,
      description: a.description ?? '',
      source:      a.source?.name ?? '',
      url:         a.url,
      publishedAt: a.publishedAt,
    }));

  if (articles.length === 0) {
    return res.json({ query, articles: [], sentiment: null });
  }

  // 2. Send headlines + descriptions to RouteLLM for sentiment analysis
  const articleTexts = articles
    .map((a, i) => `${i + 1}. ${a.title}${a.description ? ' — ' + a.description : ''}`)
    .join('\n');

  const llmRes = await routellm.chat.completions.create({
    model: 'route-llm',
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content: `You are a financial sentiment analyst. Analyse the provided news headlines about a stock or company and return a JSON object with this exact structure:
{
  "overall": "bullish" | "bearish" | "neutral",
  "score": <number from -100 (very bearish) to 100 (very bullish)>,
  "breakdown": { "bullish": <percent>, "bearish": <percent>, "neutral": <percent> },
  "themes": [<up to 4 short key themes from the articles>],
  "summary": "<2-3 sentence investor-focused summary of the sentiment>"
}
Return only valid JSON, no markdown, no explanation.`,
      },
      { role: 'user', content: `Query: ${query}\n\nHeadlines:\n${articleTexts}` },
    ],
  });

  let sentiment = null;
  try {
    const raw = (llmRes.choices[0]?.message?.content ?? '{}')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    sentiment = JSON.parse(raw);
  } catch {
    sentiment = { overall: 'neutral', score: 0, breakdown: {}, themes: [], summary: 'Could not parse sentiment response.' };
  }

  res.json({ query, articles, sentiment });
});

// Ticker extraction via RouteLLM
app.get('/api/ticker/:query', async (req, res) => {
  const query = req.params.query;

  try {
    const llmRes = await routellm.chat.completions.create({
      model: 'route-llm',
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `You are a financial data assistant. Given a search query, identify if it refers to a specific publicly traded stock or ETF.
Return ONLY a JSON object — no markdown, no explanation:
{"ticker": "AAPL", "exchange": "NASDAQ", "name": "Apple Inc."}
If no specific publicly traded security is identifiable, return:
{"ticker": null}
Common exchanges: NASDAQ, NYSE, LSE, TSX, ASX, XETRA.`,
        },
        { role: 'user', content: query },
      ],
    });

    const raw = (llmRes.choices[0]?.message?.content ?? '{}')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const result = JSON.parse(raw);
    res.json(result);
  } catch {
    res.json({ ticker: null });
  }
});

// ── Financial Modeling Prep — fundamentals ───────────────────
app.get('/api/fundamentals/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const key = process.env.FMP_API_KEY;
  try {
    const [profileRes, metricsRes] = await Promise.all([
      fetch(`https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${key}`),
      fetch(`https://financialmodelingprep.com/api/v3/key-metrics-ttm/${ticker}?apikey=${key}`),
    ]);
    const profile = await profileRes.json();
    const metrics = await metricsRes.json();

    const p = Array.isArray(profile) ? profile[0] : null;
    const m = Array.isArray(metrics) ? metrics[0] : null;
    if (!p) return res.status(404).json({ error: 'No fundamentals data found' });

    res.json({
      name:         p.companyName,
      price:        p.price,
      change:       p.changes,
      changePct:    p.changesPercentage,
      marketCap:    p.mktCap,
      sector:       p.sector,
      industry:     p.industry,
      range52w:     p.range,
      pe:           m?.peRatioTTM          ?? null,
      netMargin:    m?.netProfitMarginTTM  ?? null,
      debtToEquity: m?.debtToEquityTTM     ?? null,
      roe:          m?.returnOnEquityTTM   ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEC EDGAR — insider trades ───────────────────────────────
let cikCache = null;

async function getCIK(ticker) {
  if (!cikCache) {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'SignalApp/1.0 admin@signalapp.com' },
    });
    cikCache = await r.json();
  }
  const entry = Object.values(cikCache).find(c => c.ticker.toUpperCase() === ticker.toUpperCase());
  return entry ? String(entry.cik_str).padStart(10, '0') : null;
}

app.get('/api/insiders/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const headers = { 'User-Agent': 'SignalApp/1.0 admin@signalapp.com' };
  try {
    const cik = await getCIK(ticker);
    if (!cik) return res.json({ insiders: [] });

    const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers });
    const sub    = await subRes.json();

    const recent     = sub.filings?.recent ?? {};
    const forms      = recent.form            ?? [];
    const dates      = recent.filingDate      ?? [];
    const accessions = recent.accessionNumber ?? [];
    const docs       = recent.primaryDocument ?? [];

    const form4s = forms
      .map((f, i) => ({ form: f, date: dates[i], accession: accessions[i], doc: docs[i] }))
      .filter(x => x.form === '4')
      .slice(0, 8);

    const cikInt = parseInt(cik);

    const insiders = (await Promise.all(form4s.map(async filing => {
      try {
        const acc = filing.accession.replace(/-/g, '');
        const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc}/${filing.doc}`;
        const xml = await (await fetch(url, { headers })).text();

        const name        = xml.match(/<rptOwnerName>([^<]+)<\/rptOwnerName>/)?.[1]?.trim() ?? 'Unknown';
        const officerTitle = xml.match(/<officerTitle>([^<]+)<\/officerTitle>/)?.[1]?.trim() ?? '';
        const isDirector  = /<isDirector>1<\/isDirector>/.test(xml);
        const role        = officerTitle || (isDirector ? 'Director' : 'Insider');

        const txCodes = [...xml.matchAll(/<transactionCode>([^<]+)<\/transactionCode>/g)].map(m => m[1].trim());
        const adCodes = [...xml.matchAll(/<transactionAcquiredDisposedCode>\s*<value>([^<]+)<\/value>/g)].map(m => m[1].trim());
        const shares  = [...xml.matchAll(/<transactionShares>\s*<value>([^<]+)<\/value>/g)].map(m => parseFloat(m[1]));
        const prices  = [...xml.matchAll(/<transactionPricePerShare>\s*<value>([^<]+)<\/value>/g)].map(m => parseFloat(m[1]));

        // Only show open-market buys (P) and sells (S)
        const txIdx = txCodes.findIndex(c => c === 'P' || c === 'S');
        if (txIdx === -1) return null;

        return {
          name,
          role,
          date:   filing.date,
          type:   adCodes[txIdx] === 'A' ? 'Buy' : 'Sell',
          shares: shares[txIdx] ?? 0,
          price:  prices[txIdx] ?? 0,
          url:    `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc}/${filing.doc}`,
        };
      } catch { return null; }
    }))).filter(Boolean);

    res.json({ insiders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FMP — company profile ─────────────────────────────────────
app.get('/api/profile/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const key = process.env.FMP_API_KEY;
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/profile?symbol=${ticker}&apikey=${key}`);
    const data = await r.json();
    const p = Array.isArray(data) ? data[0] : null;
    if (!p) return res.status(404).json({ error: 'No profile found' });
    res.json({
      ticker:      p.symbol,
      name:        p.companyName,
      exchange:    p.exchange,
      price:       p.price,
      change:      p.change,
      changePct:   p.changePercentage,
      marketCap:   p.marketCap,
      sector:      p.sector,
      industry:    p.industry,
      ceo:         p.ceo,
      employees:   p.fullTimeEmployees,
      description: p.description,
      image:       p.image,
      website:     p.website,
      ipoDate:     p.ipoDate,
      country:     p.country,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FMP — historical price chart data ────────────────────────
app.get('/api/chart/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const key = process.env.FMP_API_KEY;
  try {
    const r = await fetch(
      `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&apikey=${key}`
    );
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ error: 'No price data found' });
    }
    // Return newest-first, trimmed to 1 year
    const candles = data.slice(0, 365).map(d => ({
      time:  d.date,
      open:  d.open,
      high:  d.high,
      low:   d.low,
      close: d.close,
    }));
    res.json({ ticker, candles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FMP — market movers ──────────────────────────────────────
app.get('/api/movers', async (req, res) => {
  const key = process.env.FMP_API_KEY;
  try {
    const [gainRes, loseRes] = await Promise.all([
      fetch(`https://financialmodelingprep.com/stable/biggest-gainers?apikey=${key}`),
      fetch(`https://financialmodelingprep.com/stable/biggest-losers?apikey=${key}`),
    ]);
    const [gainData, loseData] = await Promise.all([gainRes.json(), loseRes.json()]);

    const pick = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 10).map(s => ({
      symbol:  s.symbol,
      name:    s.name,
      price:   s.price,
      change:  s.change,
      changePct: s.changesPercentage,
    }));

    res.json({ gainers: pick(gainData), losers: pick(loseData) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Massive — dividends, splits, financials ──────────────────
app.get('/api/massive/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const key = process.env.MASSIVEAPI_KEY;
  const base = `https://api.massive.com`;

  try {
    const [divRes, splitRes, finRes] = await Promise.all([
      fetch(`${base}/v3/reference/dividends?ticker=${ticker}&limit=8&order=desc&sort=ex_dividend_date&apiKey=${key}`),
      fetch(`${base}/v3/reference/splits?ticker=${ticker}&limit=10&order=desc&sort=execution_date&apiKey=${key}`),
      fetch(`${base}/vX/reference/financials?ticker=${ticker}&limit=1&timeframe=ttm&apiKey=${key}`),
    ]);

    const [divData, splitData, finData] = await Promise.all([
      divRes.json(), splitRes.json(), finRes.json(),
    ]);

    const dividends = (divData.results ?? []).map(d => ({
      exDate:      d.ex_dividend_date,
      payDate:     d.pay_date,
      amount:      d.cash_amount,
      currency:    d.currency,
      frequency:   d.frequency,
      type:        d.dividend_type,
    }));

    const splits = (splitData.results ?? []).map(s => ({
      date:  s.execution_date,
      from:  s.split_from,
      to:    s.split_to,
    }));

    const fin = finData.results?.[0] ?? null;
    let financials = null;
    if (fin) {
      const is = fin.financials?.income_statement ?? {};
      const bs = fin.financials?.balance_sheet ?? {};
      const cf = fin.financials?.cash_flow_statement ?? {};
      financials = {
        period:      fin.timeframe,
        endDate:     fin.end_date,
        revenues:            is.revenues?.value ?? null,
        grossProfit:         is.gross_profit?.value ?? null,
        operatingIncome:     is.operating_income_loss?.value ?? null,
        netIncome:           is.net_income_loss?.value ?? null,
        eps:                 is.diluted_earnings_per_share?.value ?? null,
        totalAssets:         bs.assets?.value ?? null,
        totalLiabilities:    bs.liabilities?.value ?? null,
        equity:              bs.equity?.value ?? null,
        longTermDebt:        bs.long_term_debt?.value ?? null,
        operatingCashFlow:   cf.net_cash_flow_from_operating_activities?.value ?? null,
      };
    }

    res.json({ ticker, dividends, splits, financials });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── NewsAPI — financial news ─────────────────────────────────
app.get('/api/news/:query', async (req, res) => {
  const { query } = req.params;
  const key = process.env.NEWS_API_KEY;
  try {
    const newsRes = await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=relevancy&pageSize=8&apiKey=${key}`,
    );
    const data = await newsRes.json();
    if (data.status !== 'ok') throw new Error(data.message);

    const articles = (data.articles ?? [])
      .filter(a => a.title && a.url && !a.title.includes('[Removed]'))
      .map(a => ({
        title:       a.title,
        source:      a.source?.name,
        url:         a.url,
        publishedAt: a.publishedAt,
        description: a.description,
      }));

    res.json({ articles });
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
