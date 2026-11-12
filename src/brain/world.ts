/**
 * Παράθυρο στον κόσμο: δωρεάν πηγές που διαβάζει ο server όταν ο συνομιλητής το εγκρίνει.
 *
 * Μόνο οι πηγές που ορίζονται εδώ — ποτέ αυθαίρετες διευθύνσεις. Ό,τι επιστρέφεται είναι ξένο
 * κείμενο: δίνεται στο μοντέλο ως υλικό προς ανάγνωση, ποτέ ως οδηγίες.
 */

export type Source = "wikipedia" | "news" | "headlines" | "web" | "page";
export const SOURCES: Source[] = ["wikipedia", "news", "headlines", "web", "page"];

export const SOURCE_LABELS: Record<Source, string> = {
  wikipedia: "Wikipedia",
  news: "ειδήσεις",
  headlines: "ειδήσεις της ημέρας",
  web: "διαδίκτυο",
  page: "ιστοσελίδα",
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
export function parseRss(
  xml: string,
  limit = 8,
): { title: string; summary: string; source: string; date: string; link: string }[] {
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
    link: tag(item, "link"),
    date: tag(item, "pubDate"),
  }));
}

function digest(items: ReturnType<typeof parseRss>, withLinks = false): Material {
  const kept = items.filter((i) => i.title);
  return {
    titles: kept.map((i) => i.title),
    text: kept
      .map((i) => {
        // Με τον σύνδεσμο μπορεί αργότερα να ανοίξει ολόκληρο το άρθρο.
        const link = withLinks && /^https?:\/\//.test(i.link) ? `\nΣύνδεσμος: ${i.link}` : "";
        return `## ${i.title}\n${[i.source, i.date].filter(Boolean).join(" · ")}\n${i.summary}${link}`;
      })
      .join("\n\n"),
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
  return digest(parseRss(await (await get("https://www.ertnews.gr/feed/")).text(), 10), true);
}

// ------------------------------------------------------------ Ιστοσελίδες

export type Resolve = (host: string) => Promise<string[]>;

const resolveDns: Resolve = async (host) => {
  const { lookup: dnsLookup } = await import("node:dns/promises");
  return (await dnsLookup(host, { all: true })).map((a) => a.address);
};

/** Διευθύνσεις που δεν ανήκουν στο δημόσιο διαδίκτυο: τοπικές, ιδιωτικά δίκτυα, υπηρεσίες υποδομής. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip.replace(/^::ffff:/i, ""));
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * Επιτρέπεται μόνο δημόσια ιστοσελίδα: http(s), συνηθισμένη θύρα, και όνομα που καταλήγει σε
 * δημόσια διεύθυνση. Αλλιώς μια «ιστοσελίδα» θα μπορούσε να είναι εσωτερική υπηρεσία του server.
 */
export async function assertPublicUrl(raw: string, resolve: Resolve = resolveDns): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Μη έγκυρη διεύθυνση");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Μόνο διευθύνσεις http(s)");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Μη επιτρεπτή θύρα");
  if (url.username || url.password) throw new Error("Διεύθυνση με διαπιστευτήρια");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":")) throw new Error("Όχι δημόσιο όνομα");
  const addresses = /^[\d.]+$/.test(host) || host.includes(":") ? [host] : await resolve(host);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error("Η διεύθυνση δεν είναι δημόσια");
  return url;
}

/** Από HTML σε απλό κείμενο: το κυρίως περιεχόμενο αν ξεχωρίζει, χωρίς μενού, σενάρια και σήμανση. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const main = /<article\b[\s\S]*<\/article>/i.exec(body) ?? /<main\b[\s\S]*<\/main>/i.exec(body);
  if (main && main[0].length > 400) body = main[0];
  const text = decodeEntities(
    body
      .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return { title, text };
}

const MAX_PAGE_BYTES = 2_000_000;
/** Μια σελίδα κρατιέται ολόκληρη (ως αυτό το όριο)· το πόσο θα δει το μοντέλο το ορίζει ο καλών. */
export const MAX_PAGE_CHARS = 60_000;

/** Ανοίγει μια δημόσια ιστοσελίδα και επιστρέφει το κείμενό της. Κάθε ανακατεύθυνση ελέγχεται ξανά. */
export async function readPage(raw: string, resolve: Resolve = resolveDns): Promise<Material> {
  let url = await assertPublicUrl(raw, resolve);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      headers: { "user-agent": userAgent(), accept: "text/html,application/xhtml+xml,text/plain" },
      signal: AbortSignal.timeout(12_000),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new Error("Ανακατεύθυνση χωρίς προορισμό");
      url = await assertPublicUrl(new URL(next, url).toString(), resolve);
      continue;
    }
    if (!res.ok) throw new Error(`${url.host} απάντησε ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) throw new Error(`Δεν είναι σελίδα κειμένου (${type || "άγνωστος τύπος"})`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_PAGE_BYTES) throw new Error("Πολύ μεγάλη σελίδα");
    const raw = (await res.text()).slice(0, MAX_PAGE_BYTES);
    const page = /text\/plain/i.test(type) ? { title: "", text: raw.trim() } : htmlToText(raw);
    return { titles: [page.title || url.host], text: `## ${page.title || url.host}\n${url.host}\n${page.text}`.slice(0, MAX_PAGE_CHARS) };
  }
  throw new Error("Πάρα πολλές ανακατευθύνσεις");
}

export const lookup: Lookup = async (source, query) => {
  if (source === "page") return readPage(query.trim());
  const q = query.trim().slice(0, 120);
  let material: Material;
  if (source === "headlines") {
    material = await headlines();
  } else if (source === "news" || source === "web") {
    // Το "web" φτάνει εδώ μόνο ως εφεδρεία, όταν ο πάροχος μοντέλου δεν έχει δική του αναζήτηση.
    material = await news(q);
  } else {
    material = await wikipedia(q, "el");
    if (!material.text) material = await wikipedia(q, "en");
  }
  return { titles: material.titles, text: material.text.slice(0, MAX_CHARS) };
};
