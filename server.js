import express from "express";
import { chromium } from "playwright";
import { Redis } from "@upstash/redis";
import { URL } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== REDIS =====
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

app.get("/health", (req, res) => res.send("ok"));
app.head("/health", (req, res) => res.end());

// ===== PLAYWRIGHT =====
let browser, context;

async function ensureBrowser() {
  if (browser && context) return;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122",
  });
}

// ===== UTILS =====
function stripQuery(u) {
  return u.split("?")[0];
}
function cacheKey(url) {
  return `album:${url}`;
}
function getRefererFromImage(src) {
  const u = new URL(src);
  return `${u.protocol}//${u.hostname}/`;
}

// ===== SCRAPER =====
async function extractSmall(albumUrl) {
  await ensureBrowser();
  const page = await context.newPage();
  await page.goto(albumUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(500);

  const urls = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll("img").forEach((img) => {
      if (img.src) out.add(img.src);
      if (img.dataset?.src) out.add(img.dataset.src);
    });
    return [...out];
  });

  await page.close();

  return urls
    .map((u) => stripQuery(u))
    .filter((u) => u.toLowerCase().endsWith("small.jpeg"));
}

// ===== API =====
app.get("/api/yupoo", async (req, res) => {
  const albumUrl = req.query.url;
  if (!albumUrl) return res.status(400).json({ error: "Missing url" });

  // CACHE
  if (redis) {
    const cached = await redis.get(cacheKey(albumUrl));
    if (cached?.length) {
      return res.json({
        images: cached.map(
          (u) => `${req.protocol}://${req.get("host")}/img?src=${encodeURIComponent(u)}`
        ),
        cached: true,
      });
    }
  }

  const images = await extractSmall(albumUrl);

  if (redis && images.length) {
    await redis.set(cacheKey(albumUrl), images, { ex: 60 * 60 * 24 * 7 });
  }

  return res.json({
    images: images.map(
      (u) => `${req.protocol}://${req.get("host")}/img?src=${encodeURIComponent(u)}`
    ),
    cached: false,
  });
});

// ===== IMAGE PROXY =====
app.get("/img", async (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).send("Missing src");

  try {
    await ensureBrowser();
    const referer = getRefererFromImage(src);

    const r = await context.request.get(src, {
      headers: {
        Accept: "image/*",
        Referer: referer,
      },
      timeout: 60000,
    });

    const ct = r.headers()["content-type"] || "image/jpeg";
    const buf = Buffer.from(await r.body());

    if (buf.toString("utf8", 0, 20).includes("<!DOCTYPE")) {
      return res.status(403).send("Blocked by Yupoo");
    }

    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(buf);
  } catch (e) {
    return res.status(500).send(String(e));
  }
});

app.listen(PORT, () => console.log("Yupoo API running"));
