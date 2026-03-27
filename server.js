const http = require('http');
const https = require('https');

const PORT = 3456;

// ── SCRAPE (for email extraction) ───────────────────────────────────────
function scrapeUrl(targetUrl, res) {
  const parsed = new URL(targetUrl);
  const lib = parsed.protocol === 'https:' ? https : http;
  const opts = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    timeout: 8000
  };

  console.log(`[scrape] GET ${parsed.hostname}${parsed.pathname}`);

  const req = lib.request(opts, (proxyRes) => {
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      const redir = proxyRes.headers.location.startsWith('http') ? proxyRes.headers.location : `${parsed.protocol}//${parsed.hostname}${proxyRes.headers.location}`;
      proxyRes.resume();
      return scrapeUrl(redir, res);
    }
    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const result = JSON.stringify({ html: body.substring(0, 200000) });
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'content-length': Buffer.byteLength(result)
        });
        res.end(result);
      }
    });
  });

  req.on('error', (e) => {
    console.error(`[scrape] ERROR: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ html: '', error: e.message }));
    }
  });

  req.on('timeout', () => {
    req.destroy();
    if (!res.headersSent) {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ html: '', error: 'timeout' }));
    }
  });

  req.end();
}

// ── GENERIC PROXY (for Anthropic + GHL APIs) ────────────────────────────
const STRIP_REQ_HEADERS = new Set([
  'host', 'origin', 'referer', 'sec-fetch-dest', 'sec-fetch-mode',
  'sec-fetch-site', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'connection', 'accept-encoding'
]);

function proxy(targetUrl, req, res) {
  const parsed = new URL(targetUrl);
  const headers = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (!STRIP_REQ_HEADERS.has(key.toLowerCase())) headers[key] = val;
  }
  headers['host'] = parsed.host;

  const opts = {
    hostname: parsed.hostname,
    port: 443,
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers
  };

  console.log(`[proxy] ${req.method} ${parsed.hostname}${parsed.pathname}`);

  const proxyReq = https.request(opts, (proxyRes) => {
    const resHeaders = {};
    for (const [key, val] of Object.entries(proxyRes.headers)) {
      const k = key.toLowerCase();
      if (k !== 'transfer-encoding' && k !== 'content-encoding') resHeaders[key] = val;
    }
    resHeaders['access-control-allow-origin'] = '*';
    resHeaders['access-control-allow-headers'] = '*';
    resHeaders['access-control-allow-methods'] = '*';

    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks);
      resHeaders['content-length'] = body.length;
      res.writeHead(proxyRes.statusCode, resHeaders);
      res.end(body);
      if (proxyRes.statusCode >= 400) {
        console.log(`[proxy] <- ${proxyRes.statusCode} ${body.toString().substring(0, 200)}`);
      }
    });
  });

  proxyReq.on('error', (e) => {
    console.error(`[proxy] ERROR: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end('Proxy error: ' + e.message);
    }
  });

  req.pipe(proxyReq);
}

// ── GOOGLE PLACES API — Business Search ─────────────────────────────────

function placesApiFetch(path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const opts = {
      hostname: 'places.googleapis.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': body._fieldMask || '*',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    delete body._fieldMask;
    const actualData = JSON.stringify(body);
    opts.headers['Content-Length'] = Buffer.byteLength(actualData);

    const req = https.request(opts, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(actualData);
  });
}

async function newPlacesSearch(query, apiKey, maxResults, type, radiusMeters, locationBias) {
  const body = {
    textQuery: query,
    maxResultCount: Math.min(maxResults, 20),
    languageCode: 'en'
  };
  if (type) body.includedType = type;
  if (locationBias) {
    body.locationBias = {
      circle: {
        center: { latitude: locationBias.lat, longitude: locationBias.lng },
        radius: radiusMeters || 50000
      }
    };
  }
  body._fieldMask = 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.businessStatus,places.types,places.googleMapsUri,places.location';
  return placesApiFetch('/v1/places:searchText', body, apiKey);
}

// Multi-query search with Google Places — deduplicates for max unique results
async function googleSearchMultiQuery(params, res) {
  const { query, key, radius, type, limit } = params;
  const maxResults = Math.min(parseInt(limit) || 60, 60);
  const rad = parseInt(radius) || 50000;

  const parts = query.match(/^(.+?)\s+in\s+(.+)$/i);
  const cat = parts ? parts[1] : query;
  const loc = parts ? parts[2] : '';

  const NEW_API_TYPES = {
    'restaurant': 'restaurant', 'beauty_salon': 'beauty_salon', 'spa': 'spa',
    'gym': 'gym', 'dentist': 'dentist', 'doctor': 'doctor',
    'car_repair': 'car_repair', 'real_estate_agency': 'real_estate_agency',
    'lawyer': 'lawyer', 'accounting': 'accounting', 'electrician': 'electrician',
    'plumber': 'plumber', 'general_contractor': 'general_contractor',
    'veterinary_care': 'veterinary_care', 'pet_store': 'pet_store',
    'laundry': 'laundry', 'bar': 'bar', 'bakery': 'bakery'
  };
  const newType = NEW_API_TYPES[type] || '';

  let city = loc;
  let neighborhood = '';
  if (loc.includes(',')) {
    const locParts = loc.split(',').map(s => s.trim());
    neighborhood = locParts[0];
    city = locParts.slice(1).join(', ');
  }

  const queries = [query];
  if (parts) {
    queries.push(`${cat} near ${loc}`);
    queries.push(`${cat} ${loc}`);
    queries.push(`${cat} companies in ${loc}`);
    queries.push(`${cat} agency in ${loc}`);
    if (neighborhood && city) {
      queries.push(`${cat} in ${city}`);
      queries.push(`${cat} near ${neighborhood} ${city}`);
      queries.push(`${cat} office ${neighborhood} ${city}`);
    }
    queries.push(`local ${cat} in ${loc}`);
    queries.push(`${cat} services in ${loc}`);
    queries.push(`best ${cat} in ${loc}`);
    queries.push(`top rated ${cat} ${loc}`);
  } else {
    queries.push(`best ${query}`);
    queries.push(`top ${query}`);
    queries.push(`${query} companies`);
    queries.push(`${query} services`);
  }

  const seen = new Map();
  let locationBias = null;

  for (let i = 0; i < queries.length; i++) {
    if (seen.size >= maxResults) break;
    const q = queries[i];
    console.log(`[search] Query ${i + 1}/${queries.length}: "${q}"`);

    try {
      const data = await newPlacesSearch(q, key, 20, i === 0 ? newType : '', rad, locationBias);

      if (data.error) {
        console.log(`[search] ERROR: ${data.error.message || JSON.stringify(data.error)}`);
        if (i === 0) {
          const result = JSON.stringify({ status: 'REQUEST_DENIED', error_message: data.error.message || 'API error' });
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': Buffer.byteLength(result) });
          return res.end(result);
        }
        continue;
      }

      const places = data.places || [];
      console.log(`[search] -> ${places.length} results`);
      let newCount = 0;

      for (const p of places) {
        const placeId = p.id;
        if (!seen.has(placeId)) {
          seen.set(placeId, {
            place_id: placeId,
            name: p.displayName?.text || p.displayName || 'Unknown',
            formatted_address: p.formattedAddress || '',
            rating: p.rating || 0,
            user_ratings_total: p.userRatingCount || 0,
            business_status: p.businessStatus || 'OPERATIONAL',
            types: p.types || [],
            url: p.googleMapsUri || '',
            geometry: p.location ? { location: { lat: p.location.latitude, lng: p.location.longitude } } : null
          });
          newCount++;
          if (!locationBias && p.location) {
            locationBias = { lat: p.location.latitude, lng: p.location.longitude };
          }
        }
      }
      console.log(`[search] -> ${newCount} new, ${places.length - newCount} dupes. Total unique: ${seen.size}`);

    } catch(e) {
      console.error(`[search] Query ${i + 1} error: ${e.message}`);
    }
  }

  const allResults = Array.from(seen.values()).slice(0, maxResults);
  console.log(`[search] Done! Returning ${allResults.length} unique results`);
  const combined = JSON.stringify({
    status: allResults.length > 0 ? 'OK' : 'ZERO_RESULTS',
    results: allResults
  });
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': Buffer.byteLength(combined) });
  res.end(combined);
}

// ── SERPAPI — Reviews Only ───────────────────────────────────────────────

function serpApiFetch(params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const opts = {
      hostname: 'serpapi.com',
      port: 443,
      path: '/search.json?' + qs,
      method: 'GET'
    };
    const req = https.request(opts, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Parse relative date strings like "4 hours ago", "2 months ago", "a year ago"
function parseRelativeDate(dateStr, now) {
  if (!dateStr) return null;
  const s = dateStr.trim().toLowerCase();
  const n = now || new Date();
  const match = s.match(/^(a|an|\d+)\s+(hour|day|week|month|year)s?\s+ago$/);
  if (!match) return null;
  const qty = (match[1] === 'a' || match[1] === 'an') ? 1 : parseInt(match[1], 10);
  const unit = match[2];
  const d = new Date(n);
  if (unit === 'hour')  d.setHours(d.getHours() - qty);
  else if (unit === 'day')   d.setDate(d.getDate() - qty);
  else if (unit === 'week')  d.setDate(d.getDate() - qty * 7);
  else if (unit === 'month') d.setMonth(d.getMonth() - qty);
  else if (unit === 'year')  d.setFullYear(d.getFullYear() - qty);
  return d;
}

// Fetch ALL reviews via SerpApi — stops once reviews pass 6-month cutoff
async function serpReviews(placeId, apiKey) {
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  let recentReviews6m = 0;
  let recentReviews3m = 0;
  let lastReviewDate = null;
  let nextPageToken = null;
  let phone = '';
  let website = '';
  let done = false;
  let totalFetched = 0;
  let page = 0;
  const MAX_PAGES = 5; // safety cap — 5 pages × 20 reviews = 100 reviews max

  do {
    const params = {
      engine: 'google_maps_reviews',
      place_id: placeId,
      sort_by: 'newestFirst',
      api_key: apiKey,
      hl: 'en'
    };
    if (nextPageToken) params.next_page_token = nextPageToken;

    console.log(`[reviews] ${placeId} page ${page + 1}`);
    const data = await serpApiFetch(params);

    if (data.error) {
      console.log(`[reviews] SerpApi error: ${JSON.stringify(data.error)}`);
      break;
    }

    // Phone + website from place_info on first page
    if (page === 0 && data.place_info) {
      phone = data.place_info.phone || '';
      website = data.place_info.website || '';
    }

    const reviews = data.reviews || [];
    console.log(`[reviews] page ${page + 1} returned ${reviews.length} reviews. First date: ${reviews[0]?.iso_date || reviews[0]?.date || 'n/a'}`);
    totalFetched += reviews.length;

    // Count all reviews on this page (don't break mid-page — sort may not be perfect)
    for (const r of reviews) {
      const reviewDate = r.iso_date ? new Date(r.iso_date) : parseRelativeDate(r.date, now);
      if (!reviewDate) continue;
      if (!lastReviewDate || reviewDate > lastReviewDate) lastReviewDate = reviewDate;
      if (reviewDate >= sixMonthsAgo) {
        recentReviews6m++;
        if (reviewDate >= threeMonthsAgo) recentReviews3m++;
      }
    }

    // Only stop fetching more pages if the LAST review on this page is older than 6 months
    const lastInPage = reviews[reviews.length - 1];
    const lastInPageDate = lastInPage ? (lastInPage.iso_date ? new Date(lastInPage.iso_date) : parseRelativeDate(lastInPage.date, now)) : null;
    if (lastInPageDate && lastInPageDate < sixMonthsAgo) done = true;

    nextPageToken = data.serpapi_pagination?.next_page_token;
    page++;
    if (!nextPageToken || reviews.length === 0 || page >= MAX_PAGES) done = true;

  } while (!done);

  const daysSinceLastReview = lastReviewDate
    ? Math.floor((now - lastReviewDate) / (1000 * 60 * 60 * 24))
    : null;
  const monthlyVelocity = Math.round((recentReviews6m / 6) * 10) / 10;

  console.log(`[reviews] ${placeId}: 6m=${recentReviews6m} 3m=${recentReviews3m} vel=${monthlyVelocity}/mo lastReview=${daysSinceLastReview}d totalFetched=${totalFetched}`);

  return { phone, website, recentReviews6m, recentReviews3m, monthlyVelocity, daysSinceLastReview, lastReviewDate: lastReviewDate ? lastReviewDate.toISOString() : null, totalReviewsFetched: totalFetched };
}

// Google Places — phone + website only
function googlePlaceDetails(placeId, apiKey) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'places.googleapis.com',
      port: 443,
      path: `/v1/places/${placeId}`,
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'nationalPhoneNumber,internationalPhoneNumber,websiteUri'
      }
    };
    const req = https.request(opts, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve({
            phone: data.nationalPhoneNumber || data.internationalPhoneNumber || '',
            website: data.websiteUri || ''
          });
        } catch(e) { resolve({ phone: '', website: '' }); }
      });
    });
    req.on('error', () => resolve({ phone: '', website: '' }));
    req.end();
  });
}

// ── PLACE DETAILS ENDPOINT ───────────────────────────────────────────────
// Google Places → phone + website | SerpApi → reviews
async function handlePlaceDetails(params, res) {
  const { place_id, key, google_key } = params;
  if (!place_id || !key) {
    res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ status: 'ERROR', error_message: 'Missing place_id or key' }));
  }
  try {
    // Run both in parallel
    const [contact, reviews] = await Promise.all([
      google_key ? googlePlaceDetails(place_id, google_key) : Promise.resolve({ phone: '', website: '' }),
      serpReviews(place_id, key)
    ]);

    const result = JSON.stringify({
      status: 'OK',
      result: {
        formatted_phone_number: contact.phone || reviews.phone,
        website: contact.website || reviews.website,
        recentReviews6m: reviews.recentReviews6m,
        recentReviews3m: reviews.recentReviews3m,
        monthlyVelocity: reviews.monthlyVelocity,
        daysSinceLastReview: reviews.daysSinceLastReview,
        lastReviewDate: reviews.lastReviewDate,
        totalReviewsFetched: reviews.totalReviewsFetched
      }
    });
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': Buffer.byteLength(result) });
    res.end(result);
  } catch(e) {
    console.error(`[details] Error: ${e.message}`);
    const result = JSON.stringify({ status: 'OK', result: {} });
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'content-length': Buffer.byteLength(result) });
    res.end(result);
  }
}

// ── HTTP SERVER ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
      'access-control-max-age': '86400'
    });
    return res.end();
  }

  const reqPath = req.url;

  // Business search — Google Places API (fast + cheap)
  if (reqPath.startsWith('/google-search?')) {
    const params = new URL(reqPath, 'http://localhost').searchParams;
    const query = params.get('query');
    const key = params.get('key');
    if (!query || !key) {
      res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ status: 'ERROR', error_message: 'Missing query or key' }));
    }
    return googleSearchMultiQuery({ query, key, radius: params.get('radius') || '50000', type: params.get('type') || '', limit: params.get('limit') || '60' }, res);
  }

  // Reviews — SerpApi (accurate, all reviews, stops at 6-month cutoff)
  if (reqPath.startsWith('/place-details?')) {
    const params = new URL(reqPath, 'http://localhost').searchParams;
    return handlePlaceDetails({ place_id: params.get('place_id'), key: params.get('key'), google_key: params.get('google_key') }, res);
  }

  // Email scraping
  if (reqPath.startsWith('/scrape?')) {
    const params = new URL(reqPath, 'http://localhost').searchParams;
    const targetUrl = params.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ html: '', error: 'Missing url param' }));
    }
    return scrapeUrl(targetUrl, res);
  }

  // Anthropic proxy
  if (reqPath.startsWith('/anthropic/')) {
    const rest = reqPath.slice('/anthropic/'.length);
    return proxy('https://api.anthropic.com/' + rest, req, res);
  }

  // GHL proxy
  if (reqPath.startsWith('/ghl/')) {
    const rest = reqPath.slice('/ghl/'.length);
    return proxy('https://rest.gohighlevel.com/' + rest, req, res);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  ⚡ ReviewScout proxy running on http://localhost:${PORT}`);
  console.log(`  → Open your HTML file in the browser and search away\n`);
});
