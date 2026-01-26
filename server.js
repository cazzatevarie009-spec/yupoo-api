import express from "express";
import { chromium } from "playwright";
import { Redis } from "@upstash/redis";

const app = express();
const PORT = process.env.PORT || 3000;

// =====================
// 1) DOMINI YUPOO CONSENTITI (AGGIUNGI QUI)
// =====================
const ALLOWED_HOSTS = [
  "hotdog-official.x.yupoo.com",
  "elephant-factory.x.yupoo.com",
  "goat-official.x.yupoo.com",
];

// =====================
// UPSTASH REDIS
// =====================
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// =====================
// CORS
// =====================
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/health", (req, res) => res.status(200).send("ok"));
app.head("/health", (req, res) => res.status(200).end());

// =====================
// PLAYWRIGHT
// =====================
let browser = null;
let context = null;

async function ensureBrowser() {
  if (browser && context) return;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  });
}

// =====================
// UTILS
// =====================
function stripQuery(u) {
  return u.split("?")[0];
}

function publicBase(req) {
  return `https://${req.get("host")}`;
}

function cacheKey(albumUrl) {
  return `album:${albumUrl}`;
}

/**
 * Valida e normalizza URL album yupoo:
 * - deve essere https
 * - host deve essere in ALLOWED_HOSTS
 * - deve contenere /albums/...
 */
function parseAndValidateAlbumUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (u.protocol !== "https:") {
    return { ok: false, error: "Only https URLs are allowed" };
  }

  // accettiamo solo yupoo "x.yupoo.com"
  if (!u.hostname.endsWith(".x.yupoo.com")) {
    return { ok: false, error: "Only *.x.yupoo.com domains are allowed" };
  }

  // allowlist (consigliata)
  if (!ALLOWED_HOSTS.includes(u.hostname)) {
    return {
      ok: false,
      error: `Host not allowed: ${u.hostname}. Add it to ALLOWED_HOSTS.`,
    };
  }

  // obbliga a usare albums
  if (!u.pathname.includes("/albums/")) {
    return { ok: false, error: "URL must be a Yupoo album (/albums/...)" };
  }

  return { ok: true, url: u.toString(), host: u.hostname, origin: u.origin };
}

// =====================
// EXTRACT small.jpeg
// =====================
async function extractSmall(albumUrl) {
  await ensureBrowser();
  const page = await context.newPage();
  await page.goto(albumUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(700);

  const urls = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll("img").forEach((img) => {
      const s = img.getAttribute("src");
      const ds = img.getAttribute("data-src");
      if (s) out.add(s);
      if (ds) out.add(ds);
    });
    return Array.from(out);
  });

  await page.close();

  const base = new URL(albumUrl);
  const abs = urls
    .map((u) => {
      try {
        return new URL(u, base).toString();
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return Array.from(
    new Set(
      abs
        .map(stripQuery)
        .filter((u) => u.toLowerCase().endsWith("small.jpeg"))
    )
  );
}

// =====================
// API
// =====================
app.get("/api/yupoo", async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: "Missing url" });

  const validated = parseAndValidateAlbumUrl(raw);
  if (!validated.ok) return res.status(400).json({ error: validated.error });

  const albumUrl = validated.url;
  const albumOrigin = validated.origin; // es: https://goat-official.x.yupoo.com

  try {
    // 1) REDIS CACHE
    if (redis) {
      const cached = await redis.get(cacheKey(albumUrl));
      if (cached && Array.isArray(cached) && cached.length) {
        const base = publicBase(req);
        const imagesDirect = cached;

        // proxy include anche origin per referer dinamico
        const imagesProxy = cached.map(
          (u) =>
            `${base}/img?src=${encodeURIComponent(u)}&origin=${encodeURIComponent(
              albumOrigin
            )}`
        );

        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.json({
          images: cached,
          imagesDirect,
          imagesProxy,
          cached: true,
          host: validated.host,
        });
      }
    }

    // 2) SCRAPE
    const images = await extractSmall(albumUrl);

    // salva su redis 7 giorni
    if (redis && images.length) {
      await redis.set(cacheKey(albumUrl), images, { ex: 60 * 60 * 24 * 7 });
    }

    const base = publicBase(req);
    const imagesDirect = images;
    const imagesProxy = images.map(
      (u) =>
        `${base}/img?src=${encodeURIComponent(u)}&origin=${encodeURIComponent(
          albumOrigin
        )}`
    );

    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.json({
      images,
      imagesDirect,
      imagesProxy,
      cached: false,
      host: validated.host,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// =====================
// PROXY IMG (fallback)
// =====================
app.get("/img", async (req, res) => {
  const src = req.query.src;
  const origin = req.query.origin; // es: https://elephant-factory.x.yupoo.com
  if (!src) return res.status(400).send("Missing src");

  // origin è opzionale, ma se c’è lo validiamo
  let referer = "https://hotdog-official.x.yupoo.com/";
  if (origin) {
    try {
      const o = new URL(String(origin));
      if (o.protocol === "https:" && o.hostname.endsWith(".x.yupoo.com")) {
        referer = `${o.origin}/`;
      }
    } catch {
      // ignore
    }
  }

  try {
    await ensureBrowser();
    const r = await context.request.get(String(src), {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: referer,
      },
      timeout: 60000,
    });

    const ct = r.headers()["content-type"] || "image/jpeg";
    const buf = Buffer.from(await r.body());

    if (
      ct.includes("text/html") ||
      buf.slice(0, 60).toString().includes("<!DOCTYPE")
    ) {
      return res.status(403).send("Blocked by upstream.");
    }

    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(buf);
  } catch (e) {
    return res.status(500).send(String(e));
  }
});

app.listen(PORT, () => console.log(`API running on ${PORT}`));
