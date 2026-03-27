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

// ── GENERIC PROXY (for Anthropic API) ───────────────────────────────────
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

// ── PLACES API (NEW) — Server-side search + details ─────────────────────

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
    // Remove our internal _fieldMask from the body
    delete body._fieldMask;
    const actualData = JSON.stringify(body);
    opts.headers['Content-Length'] = Buffer.byteLength(actualData);

    const req = https.request(opts, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString();
          resolve(JSON.parse(text));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(actualData);
  });
}

// New API: Search Text
async function newPlacesSearch(query, apiKey, maxResults, type, radiusMeters, locationBias) {
  const body = {
    textQuery: query,
    maxResultCount: Math.min(maxResults, 20), // New API max is 20 per request
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

  const data = await placesApiFetch('/v1/places:searchText', body, apiKey);
  return data;
}

// New API: Place Details (phone + website + reviews for velocity analysis)
async function newPlaceDetails(placeId, apiKey) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'places.googleapis.com',
      port: 443,
      path: `/v1/places/${placeId}`,
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'nationalPhoneNumber,internationalPhoneNumber,websiteUri,reviews'
      }
    };

    console.log(`[details] GET places/${placeId}`);

    const req = https.request(opts, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());

          // Analyze review velocity from review dates
          const reviews = data.reviews || [];
          const now = new Date();
          const sixMonthsAgo = new Date(now);
          sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
          const threeMonthsAgo = new Date(now);
          threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

          let recentReviews6m = 0;
          let recentReviews3m = 0;
          let lastReviewDate = null;

          for (const r of reviews) {
            const reviewDate = r.publishTime ? new Date(r.publishTime) : null;
            if (reviewDate) {
              if (!lastReviewDate || reviewDate > lastReviewDate) lastReviewDate = reviewDate;
              if (reviewDate >= sixMonthsAgo) recentReviews6m++;
              if (reviewDate >= threeMonthsAgo) recentReviews3m++;
            }
          }

          // Calculate days since last review
          const daysSinceLastReview = lastReviewDate
            ? Math.floor((now - lastReviewDate) / (1000 * 60 * 60 * 24))
            : null;

          // Monthly velocity (based on 6-month window)
          const monthlyVelocity = recentReviews6m / 6;

          console.log(`[details] ${placeId}: reviews_6m=${recentReviews6m} reviews_3m=${recentReviews3m} velocity=${monthlyVelocity.toFixed(1)}/mo lastReview=${daysSinceLastReview}d ago`);

          resolve({
            phone: data.nationalPhoneNumber || data.internationalPhoneNumber || '',
            website: data.websiteUri || '',
            recentReviews6m,
            recentReviews3m,
            monthlyVelocity: Math.round(monthlyVelocity * 10) / 10,
            daysSinceLastReview,
            lastReviewDate: lastReviewDate ? lastReviewDate.toISOString() : null,
            totalReviewsFetched: reviews.length
          });
        } catch (e) {
          resolve({ phone: '', website: '', recentReviews6m: 0, recentReviews3m: 0, monthlyVelocity: 0, daysSinceLastReview: null, lastReviewDate: null, totalReviewsFetched: 0 });
        }
      });
    });
    req.on('error', () => resolve({ phone: '', website: '', recentReviews6m: 0, recentReviews3m: 0, monthlyVelocity: 0, daysSinceLastReview: null, lastReviewDate: null, totalReviewsFetched: 0 }));
    req.end();
  });
}

// ── MULTI-QUERY SEARCH (New API) ────────────────────────────────────────
// Run multiple varied queries and deduplicate by place id to get 50+ unique results

async function googleSearchMultiQuery(params, res) {
  const { query, key, radius, type, limit } = params;
  const maxResults = Math.min(parseInt(limit) || 60, 60);
  const rad = parseInt(radius) || 50000;

  // Parse "category in location" format
  const parts = query.match(/^(.+?)\s+in\s+(.+)$/i);
  const cat = parts ? parts[1] : query;
  const loc = parts ? parts[2] : '';

  // New API type mapping (singular lowercase)
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

  // Extract city/neighborhood for query variations
  let city = loc;
  let neighborhood = '';
  if (loc.includes(',')) {
    const locParts = loc.split(',').map(s => s.trim());
    neighborhood = locParts[0];
    city = locParts.slice(1).join(', ');
  }

  // Build varied queries
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

  const seen = new Map(); // place id -> result (converted to legacy format)

  // First query also gives us a location for subsequent queries
  let locationBias = null;

  for (let i = 0; i < queries.length; i++) {
    if (seen.size >= maxResults) break;

    const q = queries[i];
    console.log(`[search] Query ${i + 1}/${queries.length}: "${q}"`);

    try {
      const data = await newPlacesSearch(q, key, 20, i === 0 ? newType : '', rad, locationBias);

      if (data.error) {
        console.log(`[search] -> ERROR: ${data.error.message || JSON.stringify(data.error)}`);
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
          // Convert to legacy-style format for the HTML frontend
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

          // Use first result's location as bias for subsequent queries
          if (!locationBias && p.location) {
            locationBias = { lat: p.location.latitude, lng: p.location.longitude };
          }
        }
      }
      console.log(`[search] -> ${newCount} new, ${places.length - newCount} duplicates. Total unique: ${seen.size}`);

    } catch (e) {
      console.error(`[search] Query ${i + 1} error: ${e.message}`);
    }
  }

  const allResults = Array.from(seen.values()).slice(0, maxResults);
  console.log(`[search] Done! Returning ${allResults.length} unique results`);

  const combined = JSON.stringify({
    status: allResults.length > 0 ? 'OK' : 'ZERO_RESULTS',
    results: allResults
  });
  res.writeHead(200, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(combined)
  });
  res.end(combined);
}

// ── PLACE DETAILS ENDPOINT (New API) ────────────────────────────────────
async function handlePlaceDetails(params, res) {
  const { place_id, key } = params;
  if (!place_id || !key) {
    res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ status: 'ERROR', error_message: 'Missing place_id or key' }));
  }

  try {
    const details = await newPlaceDetails(place_id, key);
    const result = JSON.stringify({
      status: 'OK',
      result: {
        formatted_phone_number: details.phone,
        website: details.website,
        recentReviews6m: details.recentReviews6m,
        recentReviews3m: details.recentReviews3m,
        monthlyVelocity: details.monthlyVelocity,
        daysSinceLastReview: details.daysSinceLastReview,
        lastReviewDate: details.lastReviewDate,
        totalReviewsFetched: details.totalReviewsFetched
      }
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'content-length': Buffer.byteLength(result)
    });
    res.end(result);
  } catch (e) {
    console.error(`[details] Error: ${e.message}`);
    const result = JSON.stringify({ status: 'OK', result: {} });
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'content-length': Buffer.byteLength(result)
    });
    res.end(result);
  }
}

// ── HTTP SERVER ──────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Handle CORS preflight
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

  // Handle /google-search — multi-query search with New API
  if (reqPath.startsWith('/google-search?')) {
    const params = new URL(reqPath, 'http://localhost').searchParams;
    const query = params.get('query');
    const key = params.get('key');
    if (!query || !key) {
      res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ status: 'ERROR', error_message: 'Missing query or key' }));
    }
    return googleSearchMultiQuery({
      query, key,
      radius: params.get('radius') || '50000',
      type: params.get('type') || '',
      limit: params.get('limit') || '60'
    }, res);
  }

  // Handle /place-details — New API place details
  if (reqPath.startsWith('/place-details?')) {
    const params = new URL(reqPath, 'http://localhost').searchParams;
    return handlePlaceDetails({
      place_id: params.get('place_id'),
      key: params.get('key')
    }, res);
  }

  // Handle /scrape?url=... route
  if (reqPath.startsWith('/scrape?')) {
    const params = new URL(reqPath, 'http://localhost').searchParams;
    const targetUrl = params.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ html: '', error: 'Missing url param' }));
    }
    return scrapeUrl(targetUrl, res);
  }

  // Anthropic proxy (still needed for AI calls)
  if (reqPath.startsWith('/anthropic/')) {
    const rest = reqPath.slice('/anthropic/'.length);
    const targetUrl = 'https://api.anthropic.com/' + rest;
    return proxy(targetUrl, req, res);
  }

  // GHL proxy — avoids CORS when calling GHL API from browser
  if (reqPath.startsWith('/ghl/')) {
    const rest = reqPath.slice('/ghl/'.length);
    const targetUrl = 'https://rest.gohighlevel.com/' + rest;
    return proxy(targetUrl, req, res);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  ⚡ ReviewScout proxy running on http://localhost:${PORT}`);
  console.log(`  → Open your HTML file in the browser and search away\n`);
});
