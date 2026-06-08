import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { env } from "./config.js";
import type { CrawledPage } from "./crawler.js";
import type { WsClientMessage, WsServerMessage } from "./types.js";
import { createNewSession, resetSession } from "./session.js";
import { crawlWebsite } from "./crawler.js";
import { answerWithLocalFallback, answerWithRag, buildKnowledgeBase } from "./rag.js";
import { callWithFallback, type ProviderFailure } from "./llm/router.js";
import { availableProviders, type ProviderName } from "./llm/providers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function send(ws: import("ws").WebSocket, msg: WsServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function getActiveCooldownProviders(cooldowns: Partial<Record<ProviderName, number>>): Set<ProviderName> {
  const now = Date.now();
  return new Set(Object.entries(cooldowns).filter(([, until]) => typeof until === "number" && until > now).map(([provider]) => provider as ProviderName));
}

function getCooldownMs(failure: ProviderFailure): number {
  if (failure.reason === "rate_limit") return 10 * 60 * 1000;
  if (/quota|credit balance|billing|model .*not found|api key|invalid_request_error/i.test(failure.message)) return 15 * 60 * 1000;
  return 2 * 60 * 1000;
}

function applyProviderCooldowns(cooldowns: Partial<Record<ProviderName, number>>, failures: ProviderFailure[]): void {
  const now = Date.now();
  for (const failure of failures) {
    cooldowns[failure.provider] = now + getCooldownMs(failure);
  }
}

function normalizeSiteName(raw: string): string {
  const cleaned = raw
    .replace(/^www\./i, "")
    .replace(/\.[a-z]{2,}$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return "this site";
  return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function extractSiteName(seedUrl: string, pages: CrawledPage[]): string {
  const title = pages
    .map((page) => String(page.title ?? "").trim())
    .find((value) => value.length >= 3 && !/^(home|homepage|index)$/i.test(value));
  if (title) {
    const [primary] = title.split(/\s*[-|:]\s*/);
    const normalized = primary.trim();
    if (normalized) return normalized;
  }

  try {
    return normalizeSiteName(new URL(seedUrl).hostname);
  } catch {
    return "this site";
  }
}

function collectSiteCorpus(pages: CrawledPage[]): string {
  return pages
    .slice(0, 6)
    .map((page) => `${page.title ?? ""} ${page.text.slice(0, 1800)} ${page.links.join(" ")}`)
    .join(" ")
    .toLowerCase();
}

function buildSiteSuggestions(seedUrl: string, pages: CrawledPage[]): string[] {
  const siteName = extractSiteName(seedUrl, pages);
  const corpus = collectSiteCorpus(pages);
  const scored: Array<{ score: number; text: string }> = [];
  const addSuggestion = (patterns: string[], text: string) => {
    let score = 0;
    for (const pattern of patterns) {
      if (corpus.includes(pattern)) score += 1;
    }
    if (score > 0) scored.push({ score, text });
  };

  addSuggestion(["pricing", "plan", "plans", "subscription", "package", "packages", "fee", "fees"], `What are the pricing plans on ${siteName}?`);
  addSuggestion(["service", "services", "solution", "solutions", "agency", "consulting"], `What services or solutions does ${siteName} offer?`);
  addSuggestion(["product", "products", "shop", "store", "cart", "buy", "order", "checkout"], `What products are featured on ${siteName}?`);
  addSuggestion(["portfolio", "project", "projects", "case study", "case studies", "work"], `What projects or work samples does ${siteName} showcase?`);
  addSuggestion(["docs", "documentation", "api", "guide", "tutorial", "getting started"], `How do I get started with ${siteName}?`);
  addSuggestion(["blog", "article", "articles", "news", "newsletter"], `What topics does ${siteName} cover?`);
  addSuggestion(["contact", "book", "booking", "appointment", "demo", "consult", "call"], `How can someone contact or book with ${siteName}?`);
  addSuggestion(["team", "founder", "about us", "mission", "who we are"], `Who is behind ${siteName}?`);
  addSuggestion(["event", "events", "schedule", "calendar", "register"], `What events or sessions does ${siteName} list?`);
  addSuggestion(["testimonial", "testimonials", "review", "reviews"], `What do clients or users say about ${siteName}?`);

  const fallback = [
    `What is the main purpose of ${siteName}?`,
    `What should I know before using ${siteName}?`,
    `What details stand out most on ${siteName}?`
  ];

  const ordered = [...scored.sort((a, b) => b.score - a.score).map((item) => item.text), ...fallback];
  return Array.from(new Set(ordered)).slice(0, 3);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.static(path.join(__dirname, "..", "public")));

wss.on("connection", (ws) => {
  const session = createNewSession();

  send(ws, { type: "assistant_message", text: "Paste the website URL you want me to learn (example: https://example.com)." });

  ws.on("message", async (data) => {
    const raw = typeof data === "string" ? data : data.toString("utf8");
    const msg = safeJsonParse<WsClientMessage>(raw);
    if (!msg) {
      send(ws, { type: "error", text: "Invalid message format." });
      return;
    }

    if (msg.type === "reset") {
      resetSession(session);
      send(ws, { type: "assistant_message", text: "Session reset. Paste the website URL you want me to learn." });
      return;
    }

    if (msg.type !== "user_message") return;
    const text = msg.text.trim();
    if (!text) return;

    if (session.stage === "awaiting_url") {
      session.stage = "crawling";
      session.seedUrl = text;
      send(ws, { type: "status", text: "Crawling website (up to 2 links deep)..." });

      try {
        const result = await crawlWebsite(text);
        send(ws, { type: "status", text: `Crawl complete. Building knowledge base from ${result.pages.length} pages...` });
        session.kb = await buildKnowledgeBase(result.seed, result.pages);
        session.suggestions = buildSiteSuggestions(result.seed, result.pages);
        session.stage = "ready";
        send(ws, {
          type: "assistant_message",
          text: `Done. I analyzed ${session.kb.pageCount} pages. Ask me anything about the site.`,
          suggestions: session.suggestions
        });
      } catch (err) {
        resetSession(session);
        send(ws, { type: "error", text: String((err as any)?.message ?? err) });
        send(ws, { type: "assistant_message", text: "Paste the website URL you want me to learn (example: https://example.com)." });
      }
      return;
    }

    if (session.stage !== "ready" || !session.kb) {
      send(ws, { type: "status", text: "Still preparing. Please wait..." });
      return;
    }

    send(ws, { type: "status", text: "Thinking..." });

    try {
      const providers = availableProviders();
      const startIndex = providers.length === 0 ? 0 : session.nextProviderIndex % providers.length;
      const result = await callWithFallback(async (model) => {
        const { answer } = await answerWithRag({ model, kb: session.kb!, question: text });
        return answer;
      }, {
        preferredStartIndex: startIndex,
        skippedProviders: getActiveCooldownProviders(session.providerCooldowns)
      });

      applyProviderCooldowns(session.providerCooldowns, result.failures);
      session.nextProviderIndex = providers.length === 0 ? 0 : (startIndex + 1) % providers.length;

      send(ws, { type: "assistant_message", text: result.text, suggestions: session.suggestions });
    } catch (err) {
      const fallback = answerWithLocalFallback({ kb: session.kb, question: text });
      send(ws, {
        type: "status",
        text: "External AI providers are currently rate-limited or unavailable. Falling back to local website-context answering."
      });
      send(ws, { type: "assistant_message", text: fallback.answer, suggestions: session.suggestions });
    }
  });

  ws.on("close", () => {
    resetSession(session);
  });
});

server.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}`);
});
