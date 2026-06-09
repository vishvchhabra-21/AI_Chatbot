import * as cheerio from "cheerio";
import { env } from "./config.js";

export type CrawledPage = {
  url: string;
  title: string | null;
  text: string;
  links: string[];
};

type CrawlOptions = {
  maxDepth: number;
  maxPages: number;
  concurrency: number;
  timeoutMs: number;
};

// #region debug-point A:report-helper
function reportDebug(hypothesisId: string, location: string, msg: string, data: Record<string, unknown>): void {
  fetch("http://127.0.0.1:7777/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "site-context-missing",
      runId: "pre-fix",
      hypothesisId,
      location,
      msg: `[DEBUG] ${msg}`,
      data,
      ts: Date.now()
    })
  }).catch(() => {});
}
// #endregion

function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    const dropParams = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "gclid",
      "fbclid",
      "mc_cid",
      "mc_eid"
    ]);
    for (const key of Array.from(u.searchParams.keys())) {
      if (dropParams.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

function isCrawlableLink(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("mailto:")) return false;
  if (trimmed.startsWith("tel:")) return false;
  if (trimmed.startsWith("javascript:")) return false;
  if (/\.(pdf|png|jpe?g|gif|webp|svg|ico|zip|rar|7z|gz|tgz|mp4|mov|avi|mp3|wav|m4a|woff2?|ttf|eot)(\?|#|$)/i.test(trimmed)) return false;
  return true;
}

function pushIfMeaningful(target: string[], value: string | null | undefined, minLength = 10): void {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text && text.length >= minLength) target.push(text);
}

function truncateText(text: string, maxLength = 4000): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}...`;
}

function collectMetadataText($: cheerio.CheerioAPI): string[] {
  const values: string[] = [];
  const metaSelectors = [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="author"]',
    'meta[name="keywords"]',
    'meta[name="subject"]',
    'meta[name="abstract"]',
    'meta[property="og:site_name"]',
    'meta[name="article:author"]',
    'meta[name="article:section"]',
    'meta[name="article:tag"]',
    'meta[property="business:contact_data:street_address"]',
    'meta[property="business:contact_data:locality"]',
    'meta[name="email"]',
    'meta[name="url"]'
  ];

  for (const selector of metaSelectors) {
    $(selector).each((_, el) => {
      pushIfMeaningful(values, $(el).attr("content"), 5);
    });
  }

  return values;
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function summarizeJsonLdNode(node: unknown, bucket: string[]): void {
  if (!node || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  if (Array.isArray(record["@graph"])) {
    for (const item of record["@graph"] as unknown[]) summarizeJsonLdNode(item, bucket);
    return; // Don't process this level further, let recursion handle graph items
  }

  const nodeType = record["@type"];
  // Support ANY schema.org type, not just specific ones
  if (nodeType) {
    // Extract all string fields directly - comprehensive list for ANY website type
    const directFields = [
      // Universal fields
      "name", "description", "text", "headline", "articleBody", "author",
      "email", "telephone", "url", "image",
      
      // Person-specific
      "givenName", "familyName", "jobTitle",
      
      // Organization/Business
      "foundingDate", "numberOfEmployees", "streetAddress", "addressLocality",
      "addressRegion", "postalCode", "addressCountry",
      
      // Product/Offer
      "priceCurrency", "price", "offers", "availability", "sku",
      
      // Review/Rating
      "ratingValue", "reviewBody", "aggregateRating", "bestRating", "worstRating",
      
      // Event/Date
      "datePublished", "startDate", "endDate", "eventDate", "dateModified",
      
      // Organization fields
      "publisher", "about", "areaServed", "serviceArea", "knowsLanguage",
      
      // Blog/Article
      "wordCount", "timeRequired", "inLanguage"
    ];

    for (const field of directFields) {
      const value = record[field];
      if (typeof value === "string" && value.trim()) {
        pushIfMeaningful(bucket, value, 2);
      }
    }

    // Extract structured arrays - comprehensive for any content type
    const listFields = [
      "knowsAbout", "skills", "languages", "award", "sameAs",
      "offers", "benefits", "features", "tags", "keywords",
      "articleSection", "keywords", "reviews", "aggregateRating",
      "serviceType", "areaServed", "audience"
    ];
    
    for (const field of listFields) {
      const items = record[field];
      if (Array.isArray(items)) {
        const filtered = items
          .filter((item): item is string => typeof item === "string")
          .map(s => s.trim())
          .filter(s => s && !isLikelyUrl(s));
        if (filtered.length > 0) {
          pushIfMeaningful(bucket, `${field}: ${filtered.join(", ")}`, 5);
        }
      }
    }

    // Extract social profiles
    if (Array.isArray(record.sameAs)) {
      const profiles = (record.sameAs as unknown[])
        .filter((item): item is string => typeof item === "string" && isLikelyUrl(item))
        .slice(0, 5);
      if (profiles.length > 0) {
        pushIfMeaningful(bucket, `Profiles: ${profiles.join(", ")}`, 10);
      }
    }

    // Extract complex nested objects - Address
    const addressObj = record.address as Record<string, unknown> | undefined;
    if (addressObj && typeof addressObj === "object") {
      const parts = [];
      for (const key of ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"]) {
        const val = addressObj[key];
        if (typeof val === "string" && val.trim()) parts.push(val.trim());
      }
      if (parts.length > 0) {
        pushIfMeaningful(bucket, `Address: ${parts.join(", ")}`, 5);
      }
    }

    // Extract credentials/qualifications
    if (Array.isArray(record.hasCredential)) {
      const credentials = (record.hasCredential as Array<Record<string, unknown>>)
        .map((item) => {
          const name = item?.name;
          return typeof name === "string" ? name : "";
        })
        .filter(Boolean);
      if (credentials.length > 0) {
        pushIfMeaningful(bucket, `Certifications: ${credentials.join(", ")}`, 10);
      }
    }

    // Extract organizations (alumni, workplaces, etc.)
    const orgFields = ["alumniOf", "workLocation", "employer", "organization", "publisher"];
    for (const field of orgFields) {
      const items = record[field];
      if (Array.isArray(items)) {
        const orgs = (items as Array<Record<string, unknown>>)
          .map((item) => {
            const name = item?.name;
            return typeof name === "string" ? name.trim() : "";
          })
          .filter(Boolean);
        if (orgs.length > 0) {
          if (field === "alumniOf") {
            const orderedInfo = orgs.length > 1 
              ? `(listed in order: ${orgs.join(" → ")})`
              : `(${orgs[0]})`;
            pushIfMeaningful(bucket, `Past Company Affiliations: ${orgs.join(", ")} ${orderedInfo}. Based on the site, the person has worked at these companies.`, 5);
          } else {
            pushIfMeaningful(bucket, `${field}: ${orgs.join(", ")}`, 5);
          }
        }
      }
    }

    // Extract education
    if (Array.isArray(record.educationRequirements)) {
      const edu = (record.educationRequirements as Array<Record<string, unknown>>)
        .map((item) => {
          const name = item?.name;
          return typeof name === "string" ? name.trim() : "";
        })
        .filter(Boolean);
      if (edu.length > 0) {
        pushIfMeaningful(bucket, `Education: ${edu.join(", ")}`, 5);
      }
    }

    // Extract experience/employment history with dates
    if (Array.isArray(record.experience)) {
      const exp = (record.experience as Array<Record<string, unknown>>)
        .map((item) => {
          const title = item?.jobTitle;
          const org = (item?.organization as Record<string, unknown>)?.name;
          const startDate = item?.startDate;
          const endDate = item?.endDate;
          let expStr = "";
          if (typeof title === "string") {
            expStr = org && typeof org === "string" ? `${title} at ${org}` : title;
          }
          if (typeof startDate === "string" || typeof endDate === "string") {
            const dates = [];
            if (typeof startDate === "string") dates.push(`from ${startDate}`);
            if (typeof endDate === "string") dates.push(`to ${endDate}`);
            if (dates.length > 0) expStr += ` (${dates.join(" ")})`;
          }
          return expStr;
        })
        .filter(Boolean);
      if (exp.length > 0) {
        pushIfMeaningful(bucket, `Employment History: ${exp.join("; ")}`, 5);
      }
    }

    // Extract workHistory if present
    if (Array.isArray(record.workHistory)) {
      const work = (record.workHistory as Array<Record<string, unknown>>)
        .map((item) => {
          const title = item?.jobTitle || item?.position;
          const org = item?.organization || (item?.employer as Record<string, unknown>)?.name;
          const orgName = typeof org === "string" ? org : (org as Record<string, unknown>)?.name;
          const startDate = item?.startDate;
          const endDate = item?.endDate;
          let workStr = "";
          if (typeof title === "string") {
            workStr = orgName && typeof orgName === "string" ? `${title} at ${orgName}` : String(title);
          }
          if (typeof startDate === "string" || typeof endDate === "string") {
            const dates = [];
            if (typeof startDate === "string") dates.push(`from ${startDate}`);
            if (typeof endDate === "string") dates.push(`to ${endDate}`);
            if (dates.length > 0) workStr += ` (${dates.join(" ")})`;
          }
          return workStr;
        })
        .filter(Boolean);
      if (work.length > 0) {
        pushIfMeaningful(bucket, `Work History: ${work.join("; ")}`, 5);
      }
    }

    // Extract currentPosition if present
    if (record.currentPosition) {
      const current = record.currentPosition as Record<string, unknown>;
      const title = current?.jobTitle || current?.title;
      const org = current?.organization || current?.company;
      const orgName = typeof org === "string" ? org : (org as Record<string, unknown>)?.name;
      if (typeof title === "string") {
        const currentPos = orgName && typeof orgName === "string" ? `${title} at ${orgName}` : String(title);
        pushIfMeaningful(bucket, `Current Position: ${currentPos}`, 5);
      }
    }

    // Extract reviews/ratings
    if (Array.isArray(record.review)) {
      const reviews = (record.review as Array<Record<string, unknown>>)
        .map((item) => {
          const author = item?.author;
          const body = item?.reviewBody;
          const rating = item?.ratingValue;
          let reviewStr = "";
          if (typeof body === "string") reviewStr = body;
          if (typeof rating === "string" || typeof rating === "number") {
            reviewStr = `${reviewStr} (Rating: ${rating})`.trim();
          }
          return reviewStr;
        })
        .filter(Boolean)
        .slice(0, 3);
      if (reviews.length > 0) {
        pushIfMeaningful(bucket, `Reviews: ${reviews.join("; ")}`, 10);
      }
    }

    // Extract social media presence (if not in sameAs)
    const socialFields = ["facebookUrl", "twitterUrl", "instagramUrl", "linkedinUrl", "youtubeUrl", "blogUrl"];
    const socialLinks = [];
    for (const field of socialFields) {
      const url = record[field];
      if (typeof url === "string" && isLikelyUrl(url)) {
        socialLinks.push(url);
      }
    }
    if (socialLinks.length > 0) {
      pushIfMeaningful(bucket, `Social: ${socialLinks.join(", ")}`, 10);
    }
  }
}

function collectJsonLdText($: cheerio.CheerioAPI): string[] {
  const values: string[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html();
    if (!raw) return;
    try {
      summarizeJsonLdNode(JSON.parse(raw), values);
    } catch {
      return;
    }
  });

  return values;
}

function collectEmbeddedJsonText($: cheerio.CheerioAPI): string[] {
  const values: string[] = [];
  const seen = new Set<string>();

  const collectFrom = (raw: string): void => {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const stack: Array<{ value: unknown; depth: number }> = [{ value: data, depth: 0 }];
    const maxDepth = 7;
    const maxItems = 240;

    while (stack.length > 0 && values.length < maxItems) {
      const next = stack.pop();
      if (!next) break;
      const { value, depth } = next;
      if (depth > maxDepth) continue;

      if (typeof value === "string") {
        const trimmed = value.replace(/\s+/g, " ").trim();
        if (trimmed.length < 30) continue;
        if (isLikelyUrl(trimmed)) continue;
        const key = trimmed.slice(0, 160).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(truncateText(trimmed, 600));
        continue;
      }

      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], depth: depth + 1 });
        continue;
      }

      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        for (const [k, v] of Object.entries(record)) {
          if (/^(href|src|icon|logo|image|images|thumbnail|url|urls|path|slug|id)$/i.test(k)) continue;
          stack.push({ value: v, depth: depth + 1 });
        }
      }
    }
  };

  $("script").each((_, el) => {
    const id = String($(el).attr("id") ?? "");
    const type = String($(el).attr("type") ?? "");
    if (id === "__NEXT_DATA__" || type === "application/json") {
      const raw = $(el).html();
      if (!raw) return;
      if (raw.length > 3_000_000) return;
      collectFrom(raw);
    }
  });

  return values;
}

function extractTextAndLinks(html: string, baseUrl: string): { title: string | null; text: string; links: string[] } {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || null;

  const chunks: string[] = [];
  
  // Phase 1: Extract from semantic/structural elements (highest priority)
  const semanticSelectors = [
    { selector: "h1", minLength: 5 },
    { selector: "h2", minLength: 5 },
    { selector: "h3", minLength: 5 },
    { selector: "h4", minLength: 5 },
    { selector: "p", minLength: 15 },
    { selector: "article", minLength: 20 },
    { selector: "section", minLength: 20 },
    { selector: "main", minLength: 20 },
    { selector: "li", minLength: 10 },
    { selector: "[role='main']", minLength: 20 },
    { selector: "[role='article']", minLength: 20 }
  ];

  for (const { selector, minLength } of semanticSelectors) {
    $(selector).each((_, el) => {
      const t = truncateText($(el).text(), 5000);
      if (t && t.length >= minLength) chunks.push(t);
    });
  }

  // Phase 2: Collect ALL metadata (very comprehensive)
  for (const value of collectMetadataText($)) {
    pushIfMeaningful(chunks, value, 3);
  }

  // Phase 3: Collect ALL JSON-LD structured data
  for (const value of collectJsonLdText($)) {
    pushIfMeaningful(chunks, value, 3);
  }

  // Phase 3.5: Extract from embedded application JSON (Next.js and similar apps)
  for (const value of collectEmbeddedJsonText($)) {
    pushIfMeaningful(chunks, value, 10);
  }

  // Phase 4: If we still have little content, extract from broader body text
  if (chunks.length < 8) {
    // Try to extract meaningful blocks from body
    const bodySelectors = [
      "body > div:not(:empty)",
      "body > section",
      "body > article",
      "footer",
      "nav",
      "header"
    ];
    
    for (const sel of bodySelectors) {
      $(sel).each((_, el) => {
        const t = truncateText($(el).text(), 6000);
        if (t && t.length >= 30 && !chunks.some(c => c.includes(t.substring(0, 50)))) {
          chunks.push(t);
        }
      });
    }
  }

  // Phase 5: As ultimate fallback, clean up and use body text
  if (chunks.length < 5) {
    const bodyText = $("body")
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 2000); // Limit to prevent too much noise
    if (bodyText && bodyText.length >= 50) {
      chunks.push(bodyText);
    }
  }

  // Remove duplicates and join
  const uniqueByPrefix = new Map<string, string>();
  for (const chunk of chunks) {
    const normalized = chunk.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.slice(0, 260).toLowerCase();
    const existing = uniqueByPrefix.get(key);
    if (!existing || normalized.length > existing.length) uniqueByPrefix.set(key, normalized);
  }
  const text = Array.from(uniqueByPrefix.values()).join("\n");

  // #region debug-point A:extract-summary
  reportDebug("A", "src/crawler.ts:extractTextAndLinks", "Extracted page summary", {
    baseUrl,
    title,
    htmlLength: html.length,
    chunkCount: chunks.length,
    textLength: text.length
  });
  // #endregion

  $("script,noscript,style").remove();

  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") ?? "");
    if (!isCrawlableLink(href)) return;
    try {
      const abs = new URL(href, baseUrl);
      abs.hash = "";
      links.push(abs.toString());
    } catch {
      return;
    }
  });

  return { title, text, links: Array.from(new Set(links)) };
}

async function fetchHtml(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "WebsiteChatbot/0.1 (+https://localhost)"
      }
    });
    clearTimeout(t);
    // #region debug-point B:fetch-response
    reportDebug("B", "src/crawler.ts:fetchHtml", "Fetched URL", {
      url,
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get("content-type") ?? ""
    });
    // #endregion
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/html|xhtml/i.test(contentType)) return null;
    return await res.text();
  } catch {
    // #region debug-point B:fetch-failure
    reportDebug("B", "src/crawler.ts:fetchHtml", "Fetch failed", { url });
    // #endregion
    return null;
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "WebsiteChatbot/0.1 (+https://localhost)"
      }
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const raw = m[1]?.trim();
    if (raw) out.push(raw);
    if (out.length >= 1200) break;
  }
  return out;
}

async function discoverSitemapUrls(seed: URL, timeoutMs: number): Promise<string[]> {
  const candidates = new Set<string>([
    new URL("/sitemap.xml", seed).toString(),
    new URL("/sitemap_index.xml", seed).toString()
  ]);

  const robots = await fetchText(new URL("/robots.txt", seed).toString(), timeoutMs);
  if (robots) {
    const re = /^sitemap:\s*(\S+)\s*$/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(robots))) {
      if (m[1]) candidates.add(m[1].trim());
      if (candidates.size >= 6) break;
    }
  }

  const urls = new Set<string>();
  const seenSitemaps = new Set<string>();

  const processSitemap = async (sitemapUrl: string): Promise<void> => {
    if (seenSitemaps.has(sitemapUrl)) return;
    seenSitemaps.add(sitemapUrl);

    const xml = await fetchText(sitemapUrl, timeoutMs);
    if (!xml) return;

    const locs = extractSitemapLocs(xml);
    const isIndex = /<sitemapindex/i.test(xml);
    if (isIndex) {
      for (const loc of locs.slice(0, 10)) {
        const normalized = normalizeUrl(loc);
        if (!normalized) continue;
        await processSitemap(normalized);
      }
      return;
    }

    for (const loc of locs) {
      const normalized = normalizeUrl(loc);
      if (!normalized) continue;
      try {
        const u = new URL(normalized);
        if (!sameOrigin(seed, u)) continue;
      } catch {
        continue;
      }
      urls.add(normalized);
      if (urls.size >= 500) break;
    }
  };

  for (const sitemapUrl of Array.from(candidates)) {
    const normalized = normalizeUrl(sitemapUrl);
    if (!normalized) continue;
    await processSitemap(normalized);
    if (urls.size >= 200) break;
  }

  return Array.from(urls);
}

async function workerLoop(
  queue: Array<{ url: string; depth: number }>,
  visited: Set<string>,
  origin: URL,
  pages: CrawledPage[],
  opts: CrawlOptions
): Promise<void> {
  while (true) {
    const next = queue.shift();
    if (!next) return;
    if (pages.length >= opts.maxPages) return;

    const normalized = normalizeUrl(next.url);
    if (!normalized) continue;
    if (visited.has(normalized)) continue;

    let u: URL;
    try {
      u = new URL(normalized);
    } catch {
      continue;
    }
    if (!sameOrigin(origin, u)) continue;

    visited.add(normalized);

    const html = await fetchHtml(normalized, opts.timeoutMs);
    if (!html) continue;

    const { title, text, links } = extractTextAndLinks(html, normalized);
    if (!text) {
      // #region debug-point C:empty-text-drop
      reportDebug("C", "src/crawler.ts:workerLoop", "Dropping page because extracted text is empty", {
        url: normalized,
        title,
        linkCount: links.length
      });
      // #endregion
      continue;
    }

    pages.push({ url: normalized, title, text, links });
    // #region debug-point E:page-kept
    reportDebug("E", "src/crawler.ts:workerLoop", "Accepted page into crawl results", {
      url: normalized,
      title,
      textLength: text.length,
      linkCount: links.length,
      depth: next.depth
    });
    // #endregion

    if (next.depth < opts.maxDepth) {
      for (const link of links) {
        if (pages.length >= opts.maxPages) break;
        const normalizedLink = normalizeUrl(link);
        if (!normalizedLink) continue;
        if (/\/(cdn-cgi|wp-admin|wp-login)\b/i.test(normalizedLink)) continue;
        if (!visited.has(normalizedLink) && queue.length < opts.maxPages * 20) {
          queue.push({ url: normalizedLink, depth: next.depth + 1 });
        }
      }
    }
  }
}

export async function crawlWebsite(seedUrl: string): Promise<{ seed: string; pages: CrawledPage[] }> {
  const normalizedSeed = normalizeUrl(seedUrl);
  if (!normalizedSeed) throw new Error("Invalid URL. Please provide a full URL like https://example.com");

  const origin = new URL(normalizedSeed);
  const opts: CrawlOptions = {
    maxDepth: env.CRAWL_MAX_DEPTH,
    maxPages: env.CRAWL_MAX_PAGES,
    concurrency: env.CRAWL_CONCURRENCY,
    timeoutMs: env.CRAWL_TIMEOUT_MS
  };

  const queue: Array<{ url: string; depth: number }> = [{ url: normalizedSeed, depth: 0 }];
  const commonPaths = ["/about", "/about-us", "/contact", "/pricing", "/services", "/products", "/blog", "/docs"];
  for (const p of commonPaths) {
    try {
      queue.push({ url: new URL(p, origin).toString(), depth: 1 });
    } catch {
      // ignore
    }
  }

  const sitemapUrls = await discoverSitemapUrls(origin, opts.timeoutMs);
  for (const url of sitemapUrls.slice(0, Math.min(200, opts.maxPages * 4))) {
    queue.push({ url, depth: 1 });
  }
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];

  const workers = Array.from({ length: opts.concurrency }, () => workerLoop(queue, visited, origin, pages, opts));
  await Promise.all(workers);

  return { seed: normalizedSeed, pages };
}
