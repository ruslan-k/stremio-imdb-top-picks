import axios from 'axios';

// --- Base64 URL helpers ---
const b64url = {
  encode: s =>
    Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: b => {
    b = b.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return Buffer.from(b, 'base64').toString('utf8');
  }
};

function send(res, body, type = 'text/html', code = 200) {
  res.statusCode = code;
  res.setHeader('Content-Type', type);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

const PAGE = `<!doctype html><meta charset=utf8>
<title>IMDb Top Picks → Stremio</title>
<style>
body{font-family:system-ui,Arial,sans-serif;max-width:640px;margin:40px auto;padding:0 12px}
textarea{width:100%;height:8rem;margin:.7em 0;font-family:monospace}
button{padding:.5em 1.4em;border-radius:4px}
pre{background:#f6f8fa;padding:.6em 1em;border-radius:6px;overflow:auto}
</style>
<h2>Create your personal add-on URL</h2>
<ol>
  <li>Open <b>https://www.imdb.com/what-to-watch/top-picks/</b> in a logged-in tab.</li>
  <li>Copy a full <code>Cookie:</code> header from DevTools → Network.</li>
  <li>Paste it below and click <b>Generate URL</b>.</li>
</ol>
<textarea id=ck placeholder="session-id=…; uu=…"></textarea>
<button id=go>Generate URL</button>
<div id=out></div>
<script>
const enc=s=>btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
go.onclick=()=>{
  const raw=ck.value.trim().replace(/^Cookie:\\s*/i,'');
  if(!raw){alert('Paste the cookie first');return;}
  const url=location.origin+'/'+enc(raw)+'/manifest.json';
  out.innerHTML='<p>Install in Stremio:</p><pre>'+url+'</pre><p><a target=_blank href="'+url+'">Open manifest</a></p>';
};
</script>`;

const API_URL = 'https://api.graphql.imdb.com/';
const API_BODY = {
  operationName: "TopPicksTab",
  variables: {
    first: 48,
    includeUserRating: true,
    locale: "en-GB"
  },
  extensions: {
    persistedQuery: {
      sha256Hash: "df290897e7878eb47c42b3fc06701793cb2c9701c620872794325c201a4e2502",
      version: 1
    }
  }
};

// --- Helper to extract genres from GraphQL response ---
function extractGenresFromData(data) {
  const genresSet = new Set();
  const edges = data?.data?.titleRecommendations?.edges || [];
  for (const edge of edges) {
    const genresArr = edge.node?.title?.titleGenres?.genres || [];
    for (const g of genresArr) {
      if (g?.genre?.text) genresSet.add(g.genre.text);
    }
  }
  return Array.from(genresSet).sort();
}

// --- Helper to build Stremio meta object from an edge ---
function buildMeta(edge) {
  const t = edge.node?.title;
  if (!t || !t.id) return null;
  const genres = (t.titleGenres?.genres || []).map(g => g.genre.text).filter(Boolean);
  return {
    id: t.id,
    type: (t.titleType?.id === 'tvSeries' || t.titleType?.id === 'tvMiniSeries') ? 'series' : 'movie',
    name: t.titleText?.text || t.originalTitleText?.text || 'IMDb title',
    poster: t.primaryImage?.url || '',
    year: t.releaseYear?.year,
    genres,
    posterShape: 'poster',
    imdbRating: t.ratingsSummary?.aggregateRating
  };
}

// --- Helper: parse genre (and other extras) from Stremio path ---
function parseExtrasFromPath(path) {
  const parts = path.split('/');
  let extrasStr = parts[4] || '';
  extrasStr = extrasStr.replace(/\.json$/, '');
  const extras = {};
  if (extrasStr && extrasStr.includes('=')) {
    // support multiple extras: genre=Action,year=2020
    extrasStr.split(',').forEach(pair => {
      const [k, v] = pair.split('=');
      if (k && v) extras[k] = v;
    });
  }
  return extras;
}

const BASE_MANIFEST = {
  id: 'community.imdb-top-picks',
  version: '2.4.0',
  name: 'IMDb Top Picks',
  description: 'Personalized IMDb "Top Picks" for your account.',
  types: ['movie', 'series'],
  catalogs: [
    {
      id: 'imdb-top-picks',
      type: 'movie',
      name: 'IMDB Top Picks – Movies',
      extra: [
        { name: "genre", isRequired: false, options: [] }
      ]
    },
    {
      id: 'imdb-top-picks',
      type: 'series',
      name: 'IMDB Top Picks – Series',
      extra: [
        { name: "genre", isRequired: false, options: [] }
      ]
    }
  ],
  resources: ['catalog', 'meta'],
  behaviorHints: { configurable: false }
};

async function fetchImdbData(cookie) {
  let response;
  try {
    response = await axios.post(API_URL, API_BODY, {
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 12000
    });
  } catch (e) {
    throw new Error('Request to IMDb GraphQL failed: ' + (e.response?.status || '') + ' ' + (e.message || ''));
  }
  if (!response?.data?.data?.titleRecommendations?.edges?.length && response?.data?.errors) {
    const msg = response.data.errors.map(e => e.message).join(', ');
    if (msg.match(/auth/i) || msg.match(/login/i))
      throw new Error('Login required or cookie expired.');
    throw new Error('IMDb GraphQL error: ' + msg);
  }
  return response.data;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    return res.end();
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const segs = pathname.split('/').filter(Boolean);
  const hash = segs[0] && !segs[0].includes('.') ? segs[0] : '';
  const tail = hash ? '/' + segs.slice(1).join('/') : pathname;

  // Helper page for cookie input
  if (tail === '/' || tail === '/index.html') return send(res, PAGE);

  // Manifest endpoint: dynamically offer genres
  if (tail === '/manifest.json') {
    const cookie = hash ? b64url.decode(hash) : '';
    let genres = [];
    if (cookie) {
      try {
        const imdbData = await fetchImdbData(cookie);
        genres = extractGenresFromData(imdbData);
      } catch (e) {
        // fallback to empty, don't block manifest on fetch fail
      }
    }
    // Deep clone BASE_MANIFEST and inject genres
    const manifest = JSON.parse(JSON.stringify(BASE_MANIFEST));
    manifest.catalogs.forEach(cat => {
      cat.extra[0].options = genres;
    });
    manifest.id = cookie ? manifest.id + '.' + hash : manifest.id;
    return send(res, manifest, 'application/json');
  }

  // --- CATALOG ENDPOINT WITH GENRE FILTERING ---
  if (tail.startsWith('/catalog/')) {
    // Example: /catalog/movie/imdb-top-picks/genre=Action.json
    const parts = tail.split('/');
    const type = parts[2];
    const id = parts[3];
    if (!id.startsWith('imdb-top-picks'))
      return send(res, { error: 'Unknown catalog' }, 'application/json', 404);

    // Parse extras from path (like genre)
    const extras = parseExtrasFromPath(tail);

    const cookie = hash ? b64url.decode(hash) : '';
    if (!cookie)
      return send(
        res,
        { error: 'Missing IMDb cookie – generate URL via root page.' },
        'application/json',
        400
      );
    try {
      const imdbData = await fetchImdbData(cookie);
      let metas = (imdbData.data.titleRecommendations.edges || [])
        .map(buildMeta)
        .filter(Boolean)
        .filter(m => m.type === type);

      // Genre filter (case-insensitive)
      if (extras.genre) {
        const reqGenre = extras.genre.toLowerCase();
        metas = metas.filter(m =>
          Array.isArray(m.genres) &&
          m.genres.some(g => g.toLowerCase() === reqGenre)
        );
      }

      return send(res, { metas }, 'application/json');
    } catch (e) {
      console.error('[scrape]', e);
      return send(res, { error: e.message }, 'application/json', 503);
    }
  }

  // Meta stub endpoint
  if (tail.startsWith('/meta/')) {
    const [, , type, file] = tail.split('/');
    const imdbId = (file || '').replace(/\.json$/, '');
    if (!/^tt\d+$/.test(imdbId))
      return send(res, { error: 'Bad IMDb id' }, 'application/json', 400);
    const meta = {
      id: imdbId,
      type,
      name: `IMDb title ${imdbId}`,
      poster: `https://img.omdbapi.com/?i=${imdbId}&apikey=YOUR_OMDB_API_KEY`
    };
    return send(res, { meta }, 'application/json');
  }

  // 404
  return send(res, 'Not found', 'text/plain', 404);
}
