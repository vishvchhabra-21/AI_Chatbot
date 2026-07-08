import { Document } from "@langchain/core/documents";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import type { CrawledPage } from "./crawler.js";

type KnowledgeBase = {
  seed: string;
  docs: Document[];
  bm25: {
    docTermFreqs: Array<Map<string, number>>;
    docLengths: number[];
    avgDocLength: number;
    docFreq: Map<string, number>;
  };
  pageCount: number;
};

function chunkText(text: string, chunkSize = 1400, overlap = 200): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const chunks: string[] = [];
  let i = 0;

  while (i < cleaned.length) {
    const end = Math.min(cleaned.length, i + chunkSize);
    const chunk = cleaned.slice(i, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= cleaned.length) break;
    i = Math.max(0, end - overlap);
  }

  return chunks;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your"
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function buildBm25Index(docs: Document[]): KnowledgeBase["bm25"] {
  const docTermFreqs: Array<Map<string, number>> = [];
  const docLengths: number[] = [];
  const docFreq = new Map<string, number>();

  for (const doc of docs) {
    const tokens = tokenize(doc.pageContent);
    const tf = new Map<string, number>();
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    docTermFreqs.push(tf);
    docLengths.push(tokens.length);
    for (const term of tf.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }

  const avgDocLength = docLengths.length ? docLengths.reduce((a, b) => a + b, 0) / docLengths.length : 0;
  return { docTermFreqs, docLengths, avgDocLength, docFreq };
}

function retrieveBm25(kb: KnowledgeBase, query: string, k = 6): Document[] {
  const qTerms = Array.from(new Set(tokenize(query)));
  if (qTerms.length === 0) return [];

  const N = kb.docs.length;
  const k1 = 1.2;
  const b = 0.75;
  const avgdl = kb.bm25.avgDocLength || 1;
  const scores = new Array<number>(N).fill(0);

  for (const term of qTerms) {
    const df = kb.bm25.docFreq.get(term) ?? 0;
    if (df === 0) continue;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

    for (let i = 0; i < N; i++) {
      const tf = kb.bm25.docTermFreqs[i].get(term) ?? 0;
      if (tf === 0) continue;
      const dl = kb.bm25.docLengths[i] || 1;
      const denom = tf + k1 * (1 - b + (b * dl) / avgdl);
      scores[i] += idf * ((tf * (k1 + 1)) / denom);
    }
  }

  
  return scores
    .map((score, idx) => ({ score, idx }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => kb.docs[x.idx]);
}

function retrieveDocs(kb: KnowledgeBase, question: string): Document[] {
  const hits = retrieveBm25(kb, question, 10);
  if (hits.length > 0) return hits.slice(0, 8);
  return kb.docs.slice(0, Math.min(5, kb.docs.length));
}

function splitIntoSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/g)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 30);
}

function buildLocalSummary(question: string, docs: Document[]): string[] {
  const qTerms = new Set(tokenize(question));
  const scored = docs
    .flatMap((doc) =>
      splitIntoSentences(doc.pageContent).map((sentence) => ({
        sentence,
        score: tokenize(sentence).filter((term) => qTerms.has(term)).length
      }))
    )
    .sort((a, b) => b.score - a.score || b.sentence.length - a.sentence.length);

  const top = Array.from(new Set(scored.filter((item) => item.score > 0).map((item) => item.sentence))).slice(0, 3);
  if (top.length > 0) return top;

  return Array.from(new Set(docs.flatMap((doc) => splitIntoSentences(doc.pageContent)))).slice(0, 2);
}

function hasDecisionCriteria(question: string): boolean {
  return /\b(role|job|position|task|tasks|workflow|use case|usecase|project|team|budget|timeline|deadline|cost|price|priority|priorities|requirements|criteria|goal|goals|need|needs|want|wants)\b/i.test(question);
}

function detectDecisionFollowUp(question: string): string | null {
  const q = question.toLowerCase().trim();
  if (hasDecisionCriteria(q)) return null;

  const decisionPatterns: Array<{ pattern: RegExp; followUp: string }> = [
    { pattern: /why should i hire (him|her|them|this person)/i, followUp: "What role or kind of work are you hiring for?" },
    { pattern: /should i hire (him|her|them|this person)/i, followUp: "What role or kind of work are you hiring for?" },
    { pattern: /why should i use this website/i, followUp: "What day-to-day task do you want this website to help with?" },
    { pattern: /should i use this website/i, followUp: "What day-to-day task do you want this website to help with?" },
    { pattern: /would this work for me/i, followUp: "What outcome are you trying to get from it?" },
    { pattern: /is this (good|useful|worth it|right) for me/i, followUp: "What matters most to you here: speed, cost, ease of use, or a specific outcome?" },
    { pattern: /is he a good fit/i, followUp: "What role or kind of work are you evaluating him for?" },
    { pattern: /is she a good fit/i, followUp: "What role or kind of work are you evaluating her for?" },
    { pattern: /is it a good fit/i, followUp: "What role, task, or outcome are you comparing it against?" },
    { pattern: /why should i choose/i, followUp: "What matters most to you when choosing?" }
  ];

  for (const { pattern, followUp } of decisionPatterns) {
    if (pattern.test(q)) return followUp;
  }

  return null;
}

export async function buildKnowledgeBase(seed: string, pages: CrawledPage[]): Promise<KnowledgeBase> {
  const docs: Document[] = [];

  for (const page of pages) {
    const titlePart = page.title ? `Title: ${page.title}\n` : "";
    const base = `${titlePart}URL: ${page.url}\n\n${page.text}`;
    const chunks = chunkText(base);

    for (const chunk of chunks) {
      docs.push(
        new Document({
          pageContent: chunk,
          metadata: { source: page.url, title: page.title ?? undefined }
        })
      );
    }
  }

  const bm25 = buildBm25Index(docs);
  return { seed, docs, bm25, pageCount: pages.length };
}

export async function answerWithRag(params: {
  model: BaseChatModel;
  kb: KnowledgeBase;
  question: string;
}): Promise<{ answer: string; sources: string[] }> {
  const retrieved = retrieveDocs(params.kb, params.question);
  const sources = Array.from(new Set(retrieved.map((d) => String(d.metadata?.source ?? "")).filter(Boolean))).slice(0, 6);
  const summarySentences = buildLocalSummary(params.question, retrieved);

  const followUp = detectDecisionFollowUp(params.question);
  if (followUp) {
    const evidenceLead = summarySentences[0] ? `The site points to ${summarySentences[0].replace(/\.$/, "")}. ` : "";
    return {
      answer: `${evidenceLead}To make this specific, ${followUp}`,
      sources
    };
  }

  const context = retrieved
    .map((d, idx) => {
      const src = d.metadata?.source ? `Source: ${String(d.metadata.source)}` : "";
      return `---\n${src}\nChunk ${idx + 1}:\n${d.pageContent}`;
    })
    .join("\n\n");

  const now = new Date();
  const dateTimeContext = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  });

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `You are a confident, expert website analyst. Your job is to analyze and answer questions about ANY website - whether it's a person profile, business, e-commerce store, service provider, blog, or any other type of website.

ADAPTABILITY:
- Work with ANY type of website content (business, products, services, portfolio, etc.)
- Extract relevant information regardless of website type
- Provide insights that apply to the specific website context
- Be natural and conversational while maintaining accuracy

TONE & APPROACH:
- Be CONFIDENT and DIRECT in your answers
- Use the provided context as authoritative truth
- Make reasonable inferences from available data
- Do NOT hedge with phrases like "It does not specify" - instead, directly state what IS available
- Present information assertively based on evidence from the site

CURRENT CONTEXT:
- Date and time: ${dateTimeContext}
- Primary source of truth: The provided website context below
- Your knowledge cutoff applies, but the website context takes precedence

CRITICAL INSTRUCTIONS:
1. Answer MUST be grounded in the provided context - cite specific details, names, dates, numbers directly
2. For "who/what" questions - Give a complete, confident summary of the main subject and their key details
3. ALWAYS lead with the definitive answer, NOT with hedging: "According to the site..." not "The site may indicate..."
4. When data is not specified, briefly explain what IS available instead of what's missing
5. Extract ALL relevant facts and combine them into a comprehensive, coherent answer
6. Highlight key features, qualifications, offerings, or specialties with confidence
7. Use phrases like "The site shows...", "According to the profile/company...", "The context indicates..." to ground assertions
8. NEVER apologize for data limitations - simply provide what IS available and move forward with confidence
9. Make reasonable inferences: if items are listed in a sequence, that sequence may be meaningful
10. Be concise yet comprehensive - give full answers without unnecessary verbosity
11. If the user asks for a recommendation or fit judgment without giving decision criteria, do not dump a generic strengths list. Give one short evidence-based observation from the site, then ask exactly one focused follow-up question about the missing criterion
12. Never ask a checklist of questions. Ask the single most important missing question and stop`
    ],
    ["user", "Website context:\n{context}\n\nUser question:\n{question}"]
  ]);

  const chain = RunnableSequence.from([prompt, params.model, new StringOutputParser()]);
  const answer = await chain.invoke({ context, question: params.question });
  return { answer, sources };
}

export function answerWithLocalFallback(params: { kb: KnowledgeBase; question: string }): { answer: string; sources: string[] } {
  const retrieved = retrieveDocs(params.kb, params.question);
  const sources = Array.from(new Set(retrieved.map((d) => String(d.metadata?.source ?? "")).filter(Boolean))).slice(0, 6);
  const summarySentences = buildLocalSummary(params.question, retrieved);

  if (summarySentences.length === 0) {
    return {
      answer: "I could not find enough relevant information in the crawled website content to answer that confidently.",
      sources
    };
  }

  const answer = `External AI providers are temporarily unavailable, so this answer is generated from the crawled website context only.\n\n${summarySentences.join(" ")}`;
  return { answer, sources };
}

export type { KnowledgeBase };
