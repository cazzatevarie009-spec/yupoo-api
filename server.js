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

app.get("/health", (req, res) => res.status(200).send("ok"));
app.head("/health", (req, res) => res.status(200).end());

app.get("/version", (req, res) => {
  res.json({
    updated: true,
    time: new Date().toISOString(),
    note: "progressive yupoo + /img uses shop origin referer + retry",
  });
});

// ===== Playwright (solo per scraping) =====
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

// ===== In-memory running jobs =====
const RUNNING = new Set();

// ===== Utils =====
function publicBase(req) {
  return `https://${req.get("host")}`;
}
function stripQuery(u) {
  return u.split("?")[0];
}
function safeOrigin(rawAlbumUrl) {
  try {
    const u = new URL(String(rawAlbumUrl));
    return u.origin; // https://elephant-factory.x.yupoo.com
  } catch {
    return "";
  }
}
function isSmall(u) {
  const s = u.toLowerCase();
  return (
    s.includes("small.") &&
    (s.includes(".jpeg") || s.includes(".jpg") || s.includes(".png") || s.includes(".webp"))
  );
}

// Redis keys
function setKey(albumUrl) {
  return `albumset:${albumUrl}`;
}
function doneKey(albumUrl) {
  return `albumdone:${albumUrl}`;
}

// ===== Progressive scrape =====
async function scrapeAlbumProgressive(albumUrl) {
  if (!redis) return;
  if (RUNNING.has(albumUrl)) return;

  RUNNING.add(albumUrl);

  try {
    await ensureBrowser();
    const page = await context.newPage();

    page.on("response", async (resp) => {
      try {
        const u = stripQuery(resp.url());
        if (!isSmall(u)) return;
        await redis.sadd(setKey(albumUrl), u);
        await redis.expire(setKey(albumUrl), 60 * 60 * 24 * 7);
      } catch {}
    });

    await page.goto(albumUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {}
    await page.waitForTimeout(1200);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);

    // extra catch: performance resources
    try {
      const perf = await page.evaluate(() => {
        try {
          return performance.getEntriesByType("resource").map((e) => e.name).filter(Boolean);
        } catch {
          return [];
        }
      });
      for (const u0 of perf) {
        const u = stripQuery(u0);
        if (isSmall(u)) await redis.sadd(setKey(albumUrl), u);
      }
      await redis.expire(setKey(albumUrl), 60 * 60 * 24 * 7);
    } catch {}

    await page.close();
    await redis.set(doneKey(albumUrl), "1", { ex: 60 * 60 * 24 * 7 });
  } catch {
    // se fallisce, riproverà alla prossima richiesta
  } finally {
    RUNNING.delete(albumUrl);
  }
}

// ===== Progressive endpoint =====
app.get("/api/yupoo/progress", async (req, res) => {
  const albumUrl = req.query.url;
  const limit = Math.min(parseInt(req.query.limit || "300", 10) || 300, 800);

  if (!albumUrl) return res.status(400).json({ error: "Missing url" });
  if (!redis) return res.status(500).json({ error: "Redis not configured" });

  try {
    const done = (await redis.get(doneKey(albumUrl))) === "1";
    if (!done && !RUNNING.has(albumUrl)) {
      setTimeout(() => scrapeAlbumProgressive(albumUrl), 0);
    }

    const origin = safeOrigin(albumUrl); // <-- IMPORTANTISSIMO
    const originals = (await redis.smembers(setKey(albumUrl))) || [];
    originals.sort();

    const sliced = originals.slice(0, limit);
    const base = publicBase(req);

    return res.json({
      done,
      count: originals.length,
      origin,
      imagesOriginal: sliced,
      imagesProxy: sliced.map(
        (u) =>
          `${base}/img?src=${encodeURIComponent(u)}&origin=${encodeURIComponent(origin)}`
      ),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===== FAST IMAGE PROXY (fetch) + ORIGIN REFERER + RETRY =====
async function fetchImageWithRetry(src, origin, attempts = 2) {
  const headersBase = {
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  };

  // referer preferito: origin shop
  const referers = [];
  if (origin) referers.push(`${origin}/`);

  // fallback: prova anche con yupoo generico
  referers.push("https://yupoo.com/");

  let lastErr = null;

  for (let a = 0; a < attempts; a++) {
    for (const ref of referers) {
      try {
        const r = await fetch(String(src), {
          headers: { ...headersBase, Referer: ref },
          redirect: "follow",
          // Node fetch non ha timeout nativo standard: gestiamo con AbortController
          signal: (() => {
            const c = new AbortController();
            setTimeout(() => c.abort(), 15000); // 15s max per immagine
            return c.signal;
          })(),
        });

        if (!r.ok) {
          lastErr = new Error(`Upstream status ${r.status}`);
          continue;
        }

        const ct = r.headers.get("content-type") || "image/jpeg";
        const buf = Buffer.from(await r.arrayBuffer());

        const head = buf.slice(0, 140).toString().toLowerCase();
        if (ct.includes("text/html") || head.includes("<!doctype") || head.includes("<html")) {
          lastErr = new Error("Blocked (HTML returned)");
          continue;
        }

        return { ok: true, ct, buf };
      } catch (e) {
        lastErr = e;
        continue;
      }
    }
  }

  return { ok: false, error: String(lastErr || "Unknown error") };
}

app.get("/img", async (req, res) => {
  const src = req.query.src;
  const origin = req.query.origin; // <-- arriva dal client (album origin)
  if (!src) return res.status(400).send("Missing src");

  const result = await fetchImageWithRetry(String(src), origin ? String(origin) : "", 2);
  if (!result.ok) return res.status(502).send(result.error);

  res.setHeader("Content-Type", result.ct);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  return res.send(result.buf);
});

app.listen(PORT, () => console.log(`API running on ${PORT}`));
