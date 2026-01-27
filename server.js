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

// ===== HEALTH / VERSION =====
app.get("/health", (req, res) => res.status(200).send("ok"));
app.head("/health", (req, res) => res.status(200).end());

app.get("/version", (req, res) => {
  res.json({
    updated: true,
    time: new Date().toISOString(),
    note: "yupoo multi-host + resource-scan (performance entries)",
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
function getRefererFromUrl(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.hostname}/`;
  } catch {
    return "https://yupoo.com/";
  }
}

// accetta small.* con estensioni comuni (su alcuni yupoo non è small.jpeg)
function isSmallImageUrl(u) {
  const s = u.toLowerCase();
  return (
    (s.includes("small.") || s.includes("/small")) &&
    (s.includes(".jpeg") || s.includes(".jpg") || s.includes(".png") || s.includes(".webp"))
  );
}

// ===== Extract SMALL (robust): prende risorse caricate dal browser =====
async function extractSmall(albumUrl) {
  await ensureBrowser();
  const page = await context.newPage();

  await page.goto(albumUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // aspetta che yupoo faccia le chiamate e carichi immagini
  // networkidle a volte non arriva, quindi usiamo entrambi: breve wait + scroll
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {}
  await page.waitForTimeout(1200);

  // scroll per triggerare lazy-load
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // 1) tutte le risorse caricate (images incluse)
  const resources = await page.evaluate(() => {
    try {
      return performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter(Boolean);
    } catch {
      return [];
    }
  });

  // 2) fallback: anche src/data-src nel DOM (alcuni yupoo li hanno)
  const domUrls = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll("img").forEach((img) => {
      const s = img.getAttribute("src");
      const ds = img.getAttribute("data-src");
      const srcset = img.getAttribute("srcset");
      if (s) out.add(s);
      if (ds) out.add(ds);
      if (srcset) srcset.split(",").forEach((p) => out.add(p.trim().split(" ")[0]));
    });
    return Array.from(out);
  });

  // 3) fallback ulteriore: scan HTML per link small.*
  const html = await page.content();

  await page.close();

  const htmlMatches =
    html.match(/https?:\/\/[^"'\\\s]+?\bsmall\.[a-z0-9]{3,5}\b/gi) || [];
  const htmlMatches2 =
    html.match(/\/\/[^"'\\\s]+?\bsmall\.[a-z0-9]{3,5}\b/gi) || [];
  const fixed2 = htmlMatches2.map((u) => "https:" + u);

  const base = new URL(albumUrl);

  const all = [...resources, ...domUrls, ...htmlMatches, ...fixed2]
    .map((u) => {
      try {
        return new URL(u, base).toString();
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map(stripQuery);

  const filtered = all.filter(isSmallImageUrl);

  return Array.from(new Set(filtered));
}

// ===== API =====
app.get("/api/yupoo", async (req, res) => {
  const albumUrl = req.query.url;
  if (!albumUrl) return res.status(400).json({ error: "Missing url" });

  try {
    // cache redis
    if (redis) {
      const cached = await redis.get(cacheKey(albumUrl));
      if (cached && Array.isArray(cached) && cached.length) {
        const base = publicBase(req);
        const imagesProxy = cached.map(
          (u) => `${base}/img?src=${encodeURIComponent(u)}`
        );
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.json({
          images: imagesProxy,
          cached: true,
          count: cached.length,
        });
      }
    }

    const images = await extractSmall(albumUrl);

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

    const referer = getRefererFromUrl(src);

    const r = await context.request.get(src, {
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
      buf.slice(0, 120).toString().toLowerCase().includes("<!doctype")
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
