import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, decodeEntities, htmlToText, isPrivateAddress, lookup, parseRss, readPage } from "@/brain/world";

const RSS = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>Σεισμός 4,2 &amp; μετασεισμοί</title><link>http://a</link><description><![CDATA[Έγινε <b>αισθητός</b> στην Αθήνα.]]></description><pubDate>Mon, 09 Nov 2026 23:31:00 GMT</pubDate><News:Source>ert.gr</News:Source></item>
<item><title>Δεύτερη &#x3b5;ίδηση</title><description>Κείμενο &quot;δύο&quot;</description></item>
</channel></rss>`;

describe("παράθυρο στον κόσμο", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("διαβάζει τίτλους και περιλήψεις από RSS, χωρίς σήμανση", () => {
    expect(decodeEntities("&lt;a&gt; &amp; &#945;&#x3b2; &άγνωστο;")).toBe("<a> & αβ &άγνωστο;");
    expect(parseRss(RSS)).toEqual([
      { title: "Σεισμός 4,2 & μετασεισμοί", summary: "Έγινε αισθητός στην Αθήνα.", source: "ert.gr", date: "Mon, 09 Nov 2026 23:31:00 GMT", link: "http://a" },
      { title: "Δεύτερη είδηση", summary: 'Κείμενο "δύο"', source: "", date: "", link: "" },
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
    // Οι τίτλοι της ημέρας κρατούν και τον σύνδεσμο, για να μπορεί να ανοίξει το άρθρο.
    expect(m.text).toContain("Σύνδεσμος: http://a");
  });

  describe("ιστοσελίδες", () => {
    const pub: (host: string) => Promise<string[]> = async () => ["93.184.216.34"];
    const HTML = `<html><head><title>Ο τίτλος &amp; κάτι</title><style>p{}</style></head><body>
      <nav>Μενού <a href="/">Αρχική</a></nav>
      <article><h1>Επικεφαλίδα</h1><p>Πρώτη παράγραφος με <b>έμφαση</b>.</p><p>Δεύτερη.</p>
      <script>alert("όχι")</script>${"<p>Κι άλλο κείμενο για να έχει μήκος το άρθρο.</p>".repeat(8)}</article>
      <footer>Υποσέλιδο</footer></body></html>`;

    it("κρατά το κυρίως κείμενο, χωρίς μενού, σενάρια και σήμανση", () => {
      const page = htmlToText(HTML);
      expect(page.title).toBe("Ο τίτλος & κάτι");
      expect(page.text.startsWith("Επικεφαλίδα\nΠρώτη παράγραφος με έμφαση .\nΔεύτερη.")).toBe(true);
      expect(page.text).not.toMatch(/Μενού|alert|Υποσέλιδο|<|p\{\}/);
    });

    it("αρνείται ό,τι δεν είναι δημόσια ιστοσελίδα", async () => {
      for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
        expect(isPrivateAddress(ip), ip).toBe(true);
      }
      expect(isPrivateAddress("93.184.216.34")).toBe(false);
      expect(isPrivateAddress("2606:2800:220:1::1")).toBe(false);

      await expect(assertPublicUrl("https://example.com/a", pub)).resolves.toBeInstanceOf(URL);
      for (const bad of ["ftp://example.com", "file:///etc/passwd", "http://localhost/x", "http://127.0.0.1/", "http://[::1]/", "https://example.com:8080/", "https://user:pw@example.com/", "όχι διεύθυνση"]) {
        await expect(assertPublicUrl(bad, pub), bad).rejects.toThrow();
      }
      // Δημόσιο όνομα που καταλήγει σε εσωτερική διεύθυνση.
      await expect(assertPublicUrl("https://evil.example.com/", async () => ["10.0.0.5"])).rejects.toThrow("δεν είναι δημόσια");
    });

    it("διαβάζει τη σελίδα, και ελέγχει ξανά κάθε ανακατεύθυνση", async () => {
      const seen: string[] = [];
      vi.stubGlobal("fetch", async (url: URL) => {
        seen.push(String(url));
        if (String(url).includes("/old")) return new Response(null, { status: 302, headers: { location: "/new" } });
        if (String(url).includes("/trap")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
        if (String(url).includes("/pdf")) return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
        return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      });
      const page = await readPage("https://example.com/old", pub);
      expect(seen).toEqual(["https://example.com/old", "https://example.com/new"]);
      expect(page.titles).toEqual(["Ο τίτλος & κάτι"]);
      expect(page.text).toContain("Πρώτη παράγραφος");
      expect(page.text.length).toBeLessThanOrEqual(6000);

      await expect(readPage("https://example.com/trap", pub)).rejects.toThrow("δεν είναι δημόσια");
      expect(seen.some((u) => u.includes("169.254"))).toBe(false);
      await expect(readPage("https://example.com/pdf", pub)).rejects.toThrow("Δεν είναι σελίδα κειμένου");
    });
  });

  it("διαδίκτυο χωρίς αναζήτηση παρόχου: εφεδρικά, αναζήτηση ειδήσεων", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(RSS);
    });
    await lookup("web", "αποτελέσματα NBA");
    expect(new URL(urls[0]).host).toBe("www.bing.com");
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
