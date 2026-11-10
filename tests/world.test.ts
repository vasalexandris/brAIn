import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeEntities, lookup, parseRss } from "@/brain/world";

const RSS = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>Σεισμός 4,2 &amp; μετασεισμοί</title><link>http://a</link><description><![CDATA[Έγινε <b>αισθητός</b> στην Αθήνα.]]></description><pubDate>Mon, 09 Nov 2026 23:31:00 GMT</pubDate><News:Source>ert.gr</News:Source></item>
<item><title>Δεύτερη &#x3b5;ίδηση</title><description>Κείμενο &quot;δύο&quot;</description></item>
</channel></rss>`;

describe("παράθυρο στον κόσμο", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("διαβάζει τίτλους και περιλήψεις από RSS, χωρίς σήμανση", () => {
    expect(decodeEntities("&lt;a&gt; &amp; &#945;&#x3b2; &άγνωστο;")).toBe("<a> & αβ &άγνωστο;");
    expect(parseRss(RSS)).toEqual([
      { title: "Σεισμός 4,2 & μετασεισμοί", summary: "Έγινε αισθητός στην Αθήνα.", source: "ert.gr", date: "Mon, 09 Nov 2026 23:31:00 GMT" },
      { title: "Δεύτερη είδηση", summary: 'Κείμενο "δύο"', source: "", date: "" },
    ]);
  });

  it("ειδήσεις: ρωτά μόνο την προκαθορισμένη πηγή", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(RSS);
    });
    const m = await lookup("news", "σεισμός Αθήνα");
    expect(new URL(urls[0]).host).toBe("www.bing.com");
    expect(new URL(urls[0]).searchParams.get("q")).toBe("σεισμός Αθήνα");
    expect(m.titles).toHaveLength(2);
    expect(m.text).toContain("ert.gr");
  });

  it("τίτλοι ημέρας: από τη ροή της ΕΡΤ, χωρίς ερώτημα", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(RSS);
    });
    const m = await lookup("headlines", "οτιδήποτε");
    expect(urls).toEqual(["https://www.ertnews.gr/feed/"]);
    expect(m.titles[0]).toBe("Σεισμός 4,2 & μετασεισμοί");
  });

  it("Wikipedia: πρώτα ελληνικά, αλλιώς αγγλικά, με σειρά συνάφειας και όριο μήκους", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const host = new URL(url).host;
      hosts.push(host);
      if (host.startsWith("el.")) return Response.json({ batchcomplete: "" });
      return Response.json({
        query: {
          pages: {
            "7": { title: "Second", index: 2, extract: "B".repeat(9000) },
            "3": { title: "First", index: 1, extract: "A first article." },
            "9": { title: "Empty", index: 3, extract: "" },
          },
        },
      });
    });
    const m = await lookup("wikipedia", "quasar");
    expect(hosts).toEqual(["el.wikipedia.org", "en.wikipedia.org"]);
    expect(m.titles).toEqual(["First", "Second"]);
    expect(m.text.startsWith("## First\nA first article.")).toBe(true);
    expect(m.text.length).toBe(6000);
  });

  it("όταν η πηγή αρνείται, το σφάλμα φτάνει στον καλούντα", async () => {
    vi.stubGlobal("fetch", async () => new Response("too many", { status: 429 }));
    await expect(lookup("wikipedia", "x")).rejects.toThrow("429");
  });
});
