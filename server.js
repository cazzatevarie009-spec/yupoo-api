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
    note: "progressive yupoo (redis set) + background scrape",
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

// ===== In-memory running jobs (per evitare doppio scrape) =====
const RUNNING = new Set(); // albumUrl strings

// ===== Utils =====
function publicBase(req) {
  return `https://${req.get("host")}`;
}
function stripQuery(u) {
  return u.split("?")[0];
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

// ===== Scrape progressivo: intercetta risorse mentre carica =====
async function scrapeAlbumProgressive(albumUrl) {
  if (!redis) return; // senza redis non ha senso progressivo persistente
  if (RUNNING.has(albumUrl)) return;

  RUNNING.add(albumUrl);

  try {
    await ensureBrowser();
    const page = await context.newPage();

    // ogni volta che una response arriva, prendiamo la url (se small)
    page.on("response", async (resp) => {
      try {
        const u = stripQuery(resp.url());
        if (!isSmall(u)) return;
        await redis.sadd(setKey(albumUrl), u);
        // tieni 7 giorni
        await redis.expire(setKey(albumUrl), 60 * 60 * 24 * 7);
      } catch {}
    });

    await page.goto(albumUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // aspetta un po' che yupoo faccia le sue chiamate
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {}
    await page.waitForTimeout(1200);

    // scroll per trigger lazy-load
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);

    // fallback finale: performance resources (prende ciò che è stato caricato)
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
        if (isSmall(u)) {
          await redis.sadd(setKey(albumUrl), u);
        }
      }
      await redis.expire(setKey(albumUrl), 60 * 60 * 24 * 7);
    } catch {}

    await page.close();

    // marca done
    await redis.set(doneKey(albumUrl), "1", { ex: 60 * 60 * 24 * 7 });
  } catch (e) {
    // se fallisce, non blocchiamo per sempre: rilascia lock e lascia done assente
  } finally {
    RUNNING.delete(albumUrl);
  }
}

// ===== PROGRESS ENDPOINT =====
// Risponde subito con quello che c'è in Redis, e se non è "done" avvia background scrape.
app.get("/api/yupoo/progress", async (req, res) => {
  const albumUrl = req.query.url;
  const limit = Math.min(parseInt(req.query.limit || "300", 10) || 300, 800);

  if (!albumUrl) return res.status(400).json({ error: "Missing url" });
  if (!redis) return res.status(500).json({ error: "Redis not configured" });

  try {
    // avvia scrape se non done e non running
    const done = (await redis.get(doneKey(albumUrl))) === "1";
    if (!done && !RUNNING.has(albumUrl)) {
      setTimeout(() => {
        scrapeAlbumProgressive(albumUrl);
      }, 0);
    }

    // leggi set immagini
    const originals = (await redis.smembers(setKey(albumUrl))) || [];
    // stabile: ordina per stringa (non perfetto, ma stabile)
    originals.sort();

    const sliced = originals.slice(0, limit);
    const base = publicBase(req);

    const proxies = sliced.map((u) => `${base}/img?src=${encodeURIComponent(u)}`);

    return res.json({
      done,
      cached: originals.length > 0,
      count: originals.length,
      imagesOriginal: sliced,
      imagesProxy: proxies,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===== Proxy immagini (bypassa restricted access) =====
app.get("/img", async (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).send("Missing src");

  try {
    await ensureBrowser();

    // referer dinamico dal dominio della risorsa
    let referer = "https://yupoo.com/";
    try {
      const u = new URL(String(src));
      referer = `${u.protocol}//${u.hostname}/`;
    } catch {}

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
