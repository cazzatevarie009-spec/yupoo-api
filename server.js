import express from "express";
import { chromium } from "playwright";
import { Redis } from "@upstash/redis";

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

app.get("/health", (req, res) => res.status(200).send("ok"));
app.head("/health", (req, res) => res.status(200).end());

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

// ===== Extract small.jpeg =====
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

// ===== API =====
app.get("/api/yupoo", async (req, res) => {
  const albumUrl = req.query.url;
  if (!albumUrl) return res.status(400).json({ error: "Missing url" });

  try {
    // 1) Redis cache (persistente) → velocissimo SEMPRE
    if (redis) {
      const cached = await redis.get(cacheKey(albumUrl));
      if (cached && Array.isArray(cached) && cached.length) {
        const base = publicBase(req);
        const imagesDirect = cached;
        const imagesProxy = cached.map(
          (u) => `${base}/img?src=${encodeURIComponent(u)}`
        );

        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.json({
          images: cached,
          imagesDirect,
          imagesProxy,
          cached: true,
        });
      }
    }

    // 2) Se non è in Redis, scrape UNA VOLTA
    const images = await extractSmall(albumUrl);

    // salva su Redis per le prossime volte (24h/7d come vuoi)
    if (redis && images.length) {
      await redis.set(cacheKey(albumUrl), images, { ex: 60 * 60 * 24 * 7 }); // 7 giorni
    }

    const base = publicBase(req);
    const imagesDirect = images;
    const imagesProxy = images.map(
      (u) => `${base}/img?src=${encodeURIComponent(u)}`
    );

    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.json({
      images,
      imagesDirect,
      imagesProxy,
      cached: false,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===== Proxy (fallback) =====
app.get("/img", async (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).send("Missing src");

  try {
    await ensureBrowser();
    const r = await context.request.get(src, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://hotdog-official.x.yupoo.com/",
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
