import Parser from "rss-parser";
import { readFile, writeFile } from "node:fs/promises";

const CATEGORIES = [
  {
    label: "🇺🇦 Україна",
    feeds: [
      { source: "Українська правда", url: "https://www.pravda.com.ua/rss/view_mainnews/" },
      { source: "ТСН", url: "https://tsn.ua/rss/full.rss" },
      { source: "НВ", url: "https://nv.ua/rss/all.xml" }
    ]
  },
  {
    label: "⚽ Спорт",
    feeds: [
      { source: "Champion", url: "https://champion.com.ua/ukr/rss/" }
    ]
  }
];

const STATE_FILE = "state.json";
const MAX_STATE = 1000;
const MAX_AGE_HOURS = 8;
const MAX_GIST = 260;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    Accept: "application/rss+xml, application/xml, text/xml, */*"
  }
});

function escapeHtml(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clean(s = "") {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function gist(item) {
  const raw = clean(item.contentSnippet || item.summary || item.content || "");
  if (!raw) return "";
  if (raw.length <= MAX_GIST) return raw;
  const cut = raw.slice(0, MAX_GIST);
  const sp = cut.lastIndexOf(" ");
  return (sp > 120 ? cut.slice(0, sp) : cut).trim() + "…";
}

function fresh(item) {
  if (!item.isoDate) return true;
  const t = new Date(item.isoDate).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= MAX_AGE_HOURS * 3600000;
}

async function loadState() {
  try {
    const data = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return Array.isArray(data.posted) ? data.posted : [];
  } catch {
    return [];
  }
}

async function saveState(posted) {
  await writeFile(STATE_FILE, JSON.stringify({ posted: posted.slice(-MAX_STATE) }, null, 2));
}

async function send(text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHANNEL_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function pick(cat, seen) {
  for (const feed of cat.feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || [])
        .filter((i) => {
          const id = i.guid || i.link || i.title;
          return id && !seen.has(id) && fresh(i);
        })
        .sort((a, b) => new Date(b.isoDate || 0) - new Date(a.isoDate || 0));
      if (items[0]) return { item: items[0], source: feed.source };
    } catch (e) {
      console.error(`[skip] ${feed.url}: ${e.message}`);
    }
  }
  return null;
}

function format(cat, item, source) {
  const title = escapeHtml(clean(item.title || "Без заголовка"));
  const g = escapeHtml(gist(item));
  const link = item.link || "";
  let text = `${cat.label}\n\n<b>${title}</b>`;
  if (g) text += `\n\n${g}`;
  if (link) text += `\n\n🔗 <a href="${link}">Читати повністю</a> · ${escapeHtml(source)}`;
  return text;
}

async function run() {
  if (!BOT_TOKEN || !CHANNEL_ID) throw new Error("BOT_TOKEN or CHANNEL_ID missing");
  const posted = await loadState();
  const seen = new Set(posted);
  for (const cat of CATEGORIES) {
    const picked = await pick(cat, seen);
    if (!picked) continue;
    const id = picked.item.guid || picked.item.link || picked.item.title;
    try {
      await send(format(cat, picked.item, picked.source));
      posted.push(id);
      seen.add(id);
    } catch (e) {
      console.error(`[send-fail] ${e.message}`);
    }
  }
  await saveState(posted);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
