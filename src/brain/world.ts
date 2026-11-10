/**
 * Παράθυρο στον κόσμο: δωρεάν πηγές που διαβάζει ο server όταν ο συνομιλητής το εγκρίνει.
 *
 * Μόνο οι πηγές που ορίζονται εδώ — ποτέ αυθαίρετες διευθύνσεις. Ό,τι επιστρέφεται είναι ξένο
 * κείμενο: δίνεται στο μοντέλο ως υλικό προς ανάγνωση, ποτέ ως οδηγίες.
 */

export type Source = "wikipedia" | "news" | "headlines";
export const SOURCES: Source[] = ["wikipedia", "news", "headlines"];

export const SOURCE_LABELS: Record<Source, string> = {
  wikipedia: "Wikipedia",
  news: "ειδήσεις",
  headlines: "ειδήσεις της ημέρας",
};

/** Το "ερώτημα" που αποθηκεύεται όταν ζητά απλώς τους τίτλους της ημέρας. */
export const HEADLINES_QUERY = "σημερινοί τίτλοι";

export interface Material {
  titles: string[];
  text: string;
}

export type Lookup = (source: Source, query: string) => Promise<Material>;

const MAX_CHARS = 6000;

function userAgent(): string {
  // Η Wikimedia ζητά περιγραφικό User-Agent με στοιχείο επικοινωνίας (APP_CONTACT: διεύθυνση site ή email).
  return `brAIn/0.1 (${process.env.APP_CONTACT || "conversational agent"})`;
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { "user-agent": userAgent(), accept: "application/json, application/xml, text/xml" },
    signal: AbortSignal.timeout(12_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${new URL(url).host} απάντησε ${res.status}`);
  return res;
}

async function wikipedia(query: string, lang: "el" | "en"): Promise<Material> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "3",
    prop: "extracts",
    exintro: "1",
    explaintext: "1",
    exlimit: "3",
  });
  const data: any = await (await get(`https://${lang}.wikipedia.org/w/api.php?${params}`)).json();
  const pages = Object.values<any>(data?.query?.pages ?? {})
    .filter((p) => typeof p?.extract === "string" && p.extract.trim())
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return {
    titles: pages.map((p) => String(p.title)),
    text: pages.map((p) => `## ${p.title}\n${p.extract.trim()}`).join("\n\n"),
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

/** Τίτλοι και περιλήψεις από ροή RSS — χωρίς να ανοίγονται τα ίδια τα άρθρα. */
export function parseRss(xml: string, limit = 8): { title: string; summary: string; source: string; date: string }[] {
  const tag = (item: string, name: string) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(item);
    if (!m) return "";
    const raw = m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
    return decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, limit).map(([, item]) => ({
    title: tag(item, "title"),
    summary: tag(item, "description").slice(0, 320),
    source: tag(item, "News:Source"),
    date: tag(item, "pubDate"),
  }));
}

function digest(items: ReturnType<typeof parseRss>): Material {
  const kept = items.filter((i) => i.title);
  return {
    titles: kept.map((i) => i.title),
    text: kept.map((i) => `## ${i.title}\n${[i.source, i.date].filter(Boolean).join(" · ")}\n${i.summary}`).join("\n\n"),
  };
}

async function news(query: string): Promise<Material> {
  // Η μηχανή ειδήσεων της Microsoft (τροφοδοτεί και το MSN), σε μορφή RSS.
  const params = new URLSearchParams({ q: query, format: "rss", setlang: "el", cc: "GR" });
  const xml = await (await get(`https://www.bing.com/news/search?${params}`)).text();
  return digest(parseRss(xml));
}

/**
 * Οι τίτλοι της ημέρας, από τη ροή της ΕΡΤ. Οι μηχανές αναζήτησης ειδήσεων απαντούν καλά σε
 * συγκεκριμένο θέμα, αλλά σε γενικό ερώτημα («ειδήσεις σήμερα») επιστρέφουν άσχετες σελίδες.
 */
async function headlines(): Promise<Material> {
  return digest(parseRss(await (await get("https://www.ertnews.gr/feed/")).text(), 10));
}

export const lookup: Lookup = async (source, query) => {
  const q = query.trim().slice(0, 120);
  let material: Material;
  if (source === "headlines") {
    material = await headlines();
  } else if (source === "news") {
    material = await news(q);
  } else {
    material = await wikipedia(q, "el");
    if (!material.text) material = await wikipedia(q, "en");
  }
  return { titles: material.titles, text: material.text.slice(0, MAX_CHARS) };
};
