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

// ===== HEALTH (UptimeRobot) =====
app.get("/health", (req, res) => res.status(200).send("ok"));
app.head("/health", (req, res) => res.status(200).end());

// ===== Playwright (solo per estrarre lista immagini, NON per caricarle) =====
let browser = null;
let context = null;

async function ensureBrowser() {
  if (browser && context) return;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9,it;q=0.8" },
  });
}

function stripQuery(u) {
  return u.split("?")[0];
}
function getPublicBase(req) {
  return `https://${req.get("host")}`;
}

// ===== Cache album (così /api/yupoo è veloce dopo la prima) =====
const ALBUM_CACHE = new Map(); // albumUrl -> { imagesRaw, t }
const ALBUM_TTL_MS = 1000 * 60 * 60; // 1 ora

function albumGet(albumUrl) {
  const v = ALBUM_CACHE.get(albumUrl);
  if (!v) return null;
  if (Date.now() - v.t > ALBUM_TTL_MS) {
    ALBUM_CACHE.delete(albumUrl);
    return null;
  }
  return v.imagesRaw;
}

function albumSet(albumUrl, imagesRaw) {
  ALBUM_CACHE.set(albumUrl, { imagesRaw, t: Date.now() });
}

async function extractSmallJpegs(albumUrl) {
  await ensureBrowser();

  const page = await context.newPage();
  await page.goto(albumUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(900);

  const urls = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src");
      const ds = img.getAttribute("data-src");
      if (src) out.add(src);
      if (ds) out.add(ds);
    });
    document.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href");
      if (href) out.add(href);
    });
    return Array.from(out);
  });

  await page.close();

  const base = new URL(albumUrl);
  const absolute = urls
    .map((u) => {
      try {
        return new URL(u, base).toString();
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // SOLO small.jpeg
  const imagesRaw = Array.from(
    new Set(
      absolute
        .map(stripQuery)
        .filter((u) => u.toLowerCase().endsWith("small.jpeg"))
    )
  );

  return imagesRaw;
}

// ===== API: restituisce DIRECT (veloce) + PROXY (fallback) =====
app.get("/api/yupoo", async (req, res) => {
  const albumUrl = req.query.url;
  if (!albumUrl) return res.status(400).json({ error: "Missing url" });

  try {
    let imagesRaw = albumGet(albumUrl);
    if (!imagesRaw) {
      imagesRaw = await extractSmallJpegs(albumUrl);
      albumSet(albumUrl, imagesRaw);
    }

    const publicBase = getPublicBase(req);

    // DIRECT: Yupoo CDN (fast)
    const imagesDirect = imagesRaw;

    // PROXY: fallback se una direct fallisce
    const imagesProxy = imagesRaw.map(
      (u) => `${publicBase}/img?src=${encodeURIComponent(u)}`
    );

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json({ imagesDirect, imagesProxy });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===== Proxy immagine (fallback) =====
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
      return res.status(403).send("Blocked by upstream (Restricted Access).");
    }

    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.send(buf);
  } catch (e) {
    return res.status(500).send(String(e));
  }
});

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
