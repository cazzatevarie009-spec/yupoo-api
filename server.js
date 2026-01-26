import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CORS =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

// ===== HEALTH =====
app.get("/health", (req, res) => res.status(200).send("ok"));
app.head("/health", (req, res) => res.status(200).end());

// ===== Playwright (solo per lista immagini) =====
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

// ===== CACHE LISTA ALBUM (24 ORE) =====
const ALBUM_CACHE = new Map();
const ALBUM_TTL = 1000 * 60 * 60 * 24; // 24h

function albumGet(url) {
  const v = ALBUM_CACHE.get(url);
  if (!v) return null;
  if (Date.now() - v.t > ALBUM_TTL) {
    ALBUM_CACHE.delete(url);
    return null;
  }
  return v.images;
}

function albumSet(url, images) {
  ALBUM_CACHE.set(url, { images, t: Date.now() });
}

async function extractSmall(albumUrl) {
  await ensureBrowser();

  const page = await context.newPage();
  await page.goto(albumUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(600);

  const urls = await page.evaluate(() => {
    const s = new Set();
    document.querySelectorAll("img").forEach((i) => {
      if (i.src) s.add(i.src);
      if (i.dataset?.src) s.add(i.dataset.src);
    });
    return [...s];
  });

  await page.close();

  const base = new URL(albumUrl);
  return Array.from(
    new Set(
      urls
        .map((u) => {
          try {
            return new URL(u, base).toString();
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .map(stripQuery)
        .filter((u) => u.endsWith("small.jpeg"))
    )
  );
}

// ===== API ULTRA-FAST =====
app.get("/api/yupoo", async (req, res) => {
  const albumUrl = req.query.url;
  if (!albumUrl) return res.status(400).json({ error: "Missing url" });

  let images = albumGet(albumUrl);
  if (!images) {
    images = await extractSmall(albumUrl);
    albumSet(albumUrl, images);
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    imagesDirect: images, // CDN Yupoo (FAST)
  });
});

app.listen(PORT, () =>
  console.log(`API running on http://localhost:${PORT}`)
);
