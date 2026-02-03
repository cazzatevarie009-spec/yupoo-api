export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200, headers: corsHeaders() });
    }

    // API: /api/qc?url=...&max=20
    if (url.pathname === "/api/qc") {
      const target = url.searchParams.get("url");
      const max = Math.min(parseInt(url.searchParams.get("max") || "20", 10) || 20, 50);
      if (!target) return json({ error: "Missing url" }, 400);

      const src = detectSource(target);
      if (src === "unknown") {
        return json(
          { error: "Unsupported domain. Use yupoo (.x.yupoo.com), uufinds.com, or findqc.com" },
          400
        );
      }

      const cacheKey = `${src}:${target}::${max}`;
      // 1) KV cache
      if (env.ALBUM_KV) {
        const cached = await env.ALBUM_KV.get(cacheKey, "json");
        if (cached && Array.isArray(cached) && cached.length) {
          return json(
            buildResponse(cached, target, request),
            200,
            {
              "Cache-Control": "public, max-age=3600",
            }
          );
        }
      }

      // 2) fetch + parse
      try {
        let images = [];
        if (src === "yupoo") images = await extractYupooSmall(target, max);
        if (src === "uufinds") images = await extractUUFindsQc(target, max);
        if (src === "findqc") images = await extractFindQc(target, max);

        // salva KV (7 giorni)
        if (env.ALBUM_KV && images.length) {
          await env.ALBUM_KV.put(cacheKey, JSON.stringify(images), { expirationTtl: 60 * 60 * 24 * 7 });
        }

        return json(buildResponse(images, target, request), 200, {
          "Cache-Control": "public, max-age=300",
        });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // Proxy immagini: /img?src=...&ref=...
    if (url.pathname === "/img") {
      const src = url.searchParams.get("src");
      const ref = url.searchParams.get("ref") || "https://www.google.com/";
      if (!src) return new Response("Missing src", { status: 400, headers: corsHeaders() });

      try {
        // Cloudflare edge cache: memorizza direttamente le immagini
        const cache = caches.default;
        const cacheKey = new Request(request.url, request);
        const cached = await cache.match(cacheKey);
        if (cached) return withCors(cached);

        const r = await fetch(src, {
          headers: {
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": ref,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
          },
          cf: {
            cacheTtl: 31536000,
            cacheEverything: true,
          },
        });

        const ct = r.headers.get("content-type") || "image/jpeg";
        const buf = await r.arrayBuffer();

        // se ti torna HTML = bloccato
        const head = new TextDecoder().decode(buf.slice(0, 120));
        if (ct.includes("text/html") || head.includes("<!DOCTYPE")) {
          return new Response("Blocked by upstream.", { status: 403, headers: corsHeaders() });
        }

        const resp = new Response(buf, {
          status: 200,
          headers: {
            ...corsHeaders(),
            "Content-Type": ct,
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });

        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      } catch (e) {
        return new Response(String(e), { status: 500, headers: corsHeaders() });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

// ---------------- helpers ----------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  };
}
function withCors(resp) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "*");
  h.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  return new Response(resp.body, { status: resp.status, headers: h });
}
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function detectSource(u) {
  const h = new URL(u).host.toLowerCase();
  if (h.endsWith(".x.yupoo.com")) return "yupoo";
  if (h.includes("uufinds.com")) return "uufinds";
  if (h.includes("findqc.com")) return "findqc";
  return "unknown";
}

function originFromUrl(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}/`;
  } catch {
    return "";
  }
}

function buildResponse(images, pageUrl, request) {
  const base = new URL(request.url);
  const hostBase = `${base.protocol}//${base.host}`;
  const ref = originFromUrl(pageUrl);

  return {
    images,
    count: images.length,
    cached: false,
    imagesProxy: images.map(
      (u) => `${hostBase}/img?src=${encodeURIComponent(u)}&ref=${encodeURIComponent(ref)}`
    ),
  };
}

function stripQuery(u) {
  return u.split("?")[0];
}

function isJunk(u) {
  const x = (u || "").toLowerCase();
  return (
    x.startsWith("data:") ||
    x.includes("logo") ||
    x.includes("avatar") ||
    x.includes("icon") ||
    x.includes("sprite") ||
    x.includes("favicon") ||
    x.includes("loading") ||
    x.includes("placeholder")
  );
}

function looksLikeImg(u) {
  const x = (u || "").toLowerCase();
  return x.startsWith("http") && (x.includes(".jpg") || x.includes(".jpeg") || x.includes(".png") || x.includes(".webp"));
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function absUrl(base, maybe) {
  try {
    return new URL(maybe, base).toString();
  } catch {
    return null;
  }
}

function extractImageStringsDeep(obj, out) {
  if (!obj) return;
  if (typeof obj === "string") {
    if (looksLikeImg(obj) && !isJunk(obj)) out.push(obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) extractImageStringsDeep(v, out);
    return;
  }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) extractImageStringsDeep(obj[k], out);
  }
}

async function fetchHtml(targetUrl) {
  const r = await fetch(targetUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  const html = await r.text();
  return html;
}

// -------- Extractors (NO Playwright) --------

// YUPOO: cerca small.jpeg nelle stringhe HTML
async function extractYupooSmall(albumUrl, max = 20) {
  const html = await fetchHtml(albumUrl);
  const base = new URL(albumUrl);

  // prendi tutti i link che sembrano immagini
  const matches = html.match(/https?:\/\/[^"'\\s>]+/g) || [];
  const urls = matches
    .map((u) => absUrl(base, u))
    .filter(Boolean)
    .map(stripQuery)
    .filter((u) => !isJunk(u))
    .filter((u) => u.toLowerCase().endsWith("small.jpeg"));

  return uniq(urls).slice(0, max);
}

// UUFINDS: prova 3 strade: JSON embedded -> link diretti -> fallback
async function extractUUFindsQc(pageUrl, max = 20) {
  const html = await fetchHtml(pageUrl);
  const base = new URL(pageUrl);

  let found = [];

  // 1) tenta JSON in script tipo __NEXT_DATA__
  const nextData = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextData && nextData[1]) {
    try {
      const parsed = JSON.parse(nextData[1]);
      const deep = [];
      extractImageStringsDeep(parsed, deep);
      found.push(...deep);
    } catch {}
  }

  // 2) prendi URL immagini dall’HTML
  const matches = html.match(/https?:\/\/[^"'\\s>]+/g) || [];
  found.push(...matches);

  found = found
    .map((u) => absUrl(base, u))
    .filter(Boolean)
    .map(stripQuery)
    .filter((u) => looksLikeImg(u) && !isJunk(u));

  // euristica QC
  const qc = found.filter((u) => {
    const x = u.toLowerCase();
    return x.includes("qc") || x.includes("quality") || x.includes("inspect") || x.includes("inspection");
  });

  return uniq((qc.length ? qc : found)).slice(0, max);
}

// FINDQC: simile
async function extractFindQc(pageUrl, max = 20) {
  const html = await fetchHtml(pageUrl);
  const base = new URL(pageUrl);

  let found = [];

  // prova JSON embedded
  const nextData = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextData && nextData[1]) {
    try {
      const parsed = JSON.parse(nextData[1]);
      const deep = [];
      extractImageStringsDeep(parsed, deep);
      found.push(...deep);
    } catch {}
  }

  const matches = html.match(/https?:\/\/[^"'\\s>]+/g) || [];
  found.push(...matches);

  found = found
    .map((u) => absUrl(base, u))
    .filter(Boolean)
    .map(stripQuery)
    .filter((u) => looksLikeImg(u) && !isJunk(u));

  const qc = found.filter((u) => {
    const x = u.toLowerCase();
    return x.includes("qc") || x.includes("quality") || x.includes("inspect") || x.includes("inspection");
  });

  return uniq((qc.length ? qc : found)).slice(0, max);
}
