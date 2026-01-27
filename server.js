import express from "express";
import { chromium } from "playwright";
import { Redis } from "@upstash/redis";
import { URL } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

// ====== UPSTASH REDIS ======
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// ===== CORS =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

// ===== HEALTH =====
app.get("/health", (req, res) => res.status(200).send("ok"));
app.head("/health", (req, res) => res.status(200).end());

// (opzionale) per capire al 100% che versione sta girando su Render
app.get("/version", (req, res) => {
  res.json({
    updated: true,
    time: new Date().toISOString(),
    note: "multi-yupoo + robust html regex small.jpeg",
  });
});

// ===== Playwright =====
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

function stripQuery(u) {
  return u.split("?")[0];
}
function publicBase(req) {
  return `https://${req.get("host")}`;
}
function cacheKey(albumUrl) {
  return `album:${albumUrl}`;
}
function getRefererFromImage(src) {
  // Referer dinamico in base all'hostname dell'immagine (hotdog/elephant/goat ecc)
  const u = new URL(src);
  return `${u.protocol}//${u.hostname}/`;
}

// ===== Extract small.jpeg (ROBUSTO) =====
// - Funziona anche quando Yupoo non mette i link dentro <img src> / data-src
// - Cerca direttamente nell'HTML (include script inline) con regex
async function extractSmall(albumUrl) {
  await ensureBrowser();
  const page = await context.newPage();

  await page.goto(albumUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // aspetta un attimo (alcuni yupoo popolano script/markup dopo il load)
  await page.waitForTimeout(1200);

  const html = await page.content();
  await page.close();

  // link completi: https://...small.jpeg
  const matches = html.match(/https?:\/\/[^"'\\\s]+small\.jpeg/gi) || [];

  // link protocol-relative: //photo.yupoo.com/...small.jpeg
  const matches2 = html.match(/\/\/[^"'\\\s]+small\.jpeg/gi) || [];
  const fixed2 = matches2.map((u) => "https:" + u);

  // de-dup + rimuove querystring
  return Array.from(new Set([...matches, ...fixed2].map(stripQuery)));
}

// ===== API =====
app.get("/api/yupoo", async (req, res) => {
  const albumUrl = req.query.url;
  if (!albumUrl) return res.status(400).json({ error: "Missing url" });

  try {
    // 1) Redis cache (persistente) → velocissimo
    if (redis) {
      const cached = await redis.get(cacheKey(albumUrl));
      if (cached && Array.isArray(cached) && cached.length) {
        const base = publicBase(req);
        const imagesProxy = cached.map(
          (u) => `${base}/img?src=${encodeURIComponent(u)}`
        );

        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.json({
          images: imagesProxy, // usa sempre proxy (evita Restricted Access)
          cached: true,
          count: cached.length,
        });
      }
    }

    // 2) Se non è in Redis, scrape una volta
    const images = await extractSmall(albumUrl);

    // salva su Redis (7 giorni)
    if (redis && images.length) {
      await redis.set(cacheKey(albumUrl), images, { ex: 60 * 60 * 24 * 7 });
    }

    const base = publicBase(req);
    const imagesProxy = images.map(
      (u) => `${base}/img?src=${encodeURIComponent(u)}`
    );

    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.json({
      images: imagesProxy,
      cached: false,
      count: images.length,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===== Proxy immagini (bypassa Restricted Access) =====
app.get("/img", async (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).send("Missing src");

  try {
    await ensureBrowser();

    const referer = getRefererFromImage(src);

    const r = await context.request.get(src, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: referer, // dinamico: hotdog/elephant/goat ecc
      },
      timeout: 60000,
    });

    const ct = r.headers()["content-type"] || "image/jpeg";
    const buf = Buffer.from(await r.body());

    // se yupoo ti blocca e ti manda HTML
    if (
      ct.includes("text/html") ||
      buf.slice(0, 80).toString().toLowerCase().includes("<!doctype")
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
