import { crawlWebsite } from "../src/crawler.js";
import { answerWithLocalFallback, buildKnowledgeBase } from "../src/rag.js";

async function main(): Promise<void> {
  const targetUrl = process.argv[2] ?? "https://example.com";
  console.log(`Crawling ${targetUrl}`);

  const crawled = await crawlWebsite(targetUrl);
  console.log(`Pages crawled: ${crawled.pages.length}`);

  const kb = await buildKnowledgeBase(crawled.seed, crawled.pages);
  console.log(`Knowledge base docs ready from ${kb.pageCount} pages`);

  const fallback = answerWithLocalFallback({ kb, question: "What is this website about?" });
  console.log("Chosen provider: local-fallback");
  console.log(fallback.answer);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
