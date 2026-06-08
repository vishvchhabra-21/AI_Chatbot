# Debug Session: site-context-missing
- **Status**: [OPEN]
- **Issue**: Some websites complete crawling with 0 analyzed pages, so the chatbot answers without real site context.
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-site-context-missing.ndjson

## Reproduction Steps
1. Open the chatbot UI.
2. Submit a website URL such as `https://dheerajchhabra.in/`.
3. Observe the crawler status and final analyzed page count.
4. Ask a site-specific question and compare the answer with the actual site content.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | Extraction selectors miss the real content blocks, producing near-empty page text | High | Low | Confirmed |
| B | The target site serves a blocked/challenge or non-HTML response to the crawler | High | Low | Rejected |
| C | Homepage fetch succeeds but is discarded because extracted text is empty | High | Low | Confirmed |
| D | The site is primarily client-rendered, so raw HTML lacks meaningful text | Med | Med | Confirmed |
| E | Docs exist, but retrieval/context assembly drops them before answer generation | Med | Low | Rejected |

## Log Evidence
- Pre-fix evidence from `.dbg/trae-debug-log-site-context-missing.ndjson`:
- `Fetched URL` shows `status: 200`, `ok: true`, `contentType: text/html; charset=utf-8`, which rejects the blocked/non-HTML hypothesis.
- `Extracted page summary` shows `chunkCount: 0`, `textLength: 0`, while the HTML title is present, confirming extraction failed before knowledge-base creation.
- `Dropping page because extracted text is empty` confirms the homepage was discarded, causing the final analyzed page count to become `0`.
- Raw HTML inspection of `raw-page.html` shows a client-rendered `<div id="root"></div>` body plus rich `meta` and `application/ld+json` data, confirming structured metadata is available even when visible body text is not.
- Post-fix evidence from the same log file now shows `chunkCount: 36`, `textLength: 1201`, and `Accepted page into crawl results`, confirming the homepage is retained.

## Verification Conclusion
- Pre-fix: `npm run smoke -- https://dheerajchhabra.in/` returned `Pages crawled: 0`, and the answer had no site-specific grounding.
- Post-fix: the same command returns `Pages crawled: 1` and answers with the site owner's name, role, and `21+` years of experience from the site's metadata.
- Minimal fix applied: fallback extraction now uses body text, SEO metadata, and JSON-LD structured data when ordinary visible selectors do not yield enough content.
- Rate-limit mitigation applied: prompt handling now rotates only across the key-backed providers loaded from `API keys.txt`, applies temporary cooldowns to failed providers, and falls back to local website-context answering when all external providers are unavailable.
