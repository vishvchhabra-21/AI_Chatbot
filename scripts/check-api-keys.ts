import { apiKeys, API_KEYS_FILE, env } from "../src/config.js";

type ProviderName = "openrouter" | "gemini" | "groq";

type CheckResult = {
  provider: ProviderName;
  ok: boolean;
  message: string;
};

function getTextSnippet(body: string): string {
  const text = body.trim();
  if (!text) return "";
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function extractErrorMessage(body: string): string {
  const snippet = getTextSnippet(body);
  if (!snippet) return "Empty error response";

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }

    const message = parsed.message;
    if (typeof message === "string") return message;
  } catch {
    // Fall through to the raw snippet.
  }

  return snippet;
}

async function fetchJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function testOpenRouter(): Promise<CheckResult> {
  const key = apiKeys.OPENROUTER_API_KEY;
  if (!key) return { provider: "openrouter", ok: false, message: "No key found in API keys.txt" };

  const result = await fetchJson("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Website Chatbot"
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL,
      messages: [{ role: "user", content: "Reply with ok." }],
      max_tokens: 1,
      temperature: 0
    })
  });

  if (!result.ok) {
    return { provider: "openrouter", ok: false, message: `HTTP ${result.status}: ${extractErrorMessage(result.body)}` };
  }

  return { provider: "openrouter", ok: true, message: "Key accepted and chat completion succeeded" };
}

async function testGemini(): Promise<CheckResult> {
  const key = apiKeys.GOOGLE_API_KEY;
  if (!key) return { provider: "gemini", ok: false, message: "No key found in API keys.txt" };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(key)}`;
  const result = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: "Reply with ok." }] }],
      generationConfig: {
        maxOutputTokens: 1,
        temperature: 0
      }
    })
  });

  if (!result.ok) {
    return { provider: "gemini", ok: false, message: `HTTP ${result.status}: ${extractErrorMessage(result.body)}` };
  }

  return { provider: "gemini", ok: true, message: "Key accepted and generateContent succeeded" };
}

async function testGroq(): Promise<CheckResult> {
  const key = apiKeys.GROQ_API_KEY;
  if (!key) return { provider: "groq", ok: false, message: "No key found in API keys.txt" };

  const result = await fetchJson("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.GROQ_MODEL,
      messages: [{ role: "user", content: "Reply with ok." }],
      max_tokens: 1,
      temperature: 0
    })
  });

  if (!result.ok) {
    return { provider: "groq", ok: false, message: `HTTP ${result.status}: ${extractErrorMessage(result.body)}` };
  }

  return { provider: "groq", ok: true, message: "Key accepted and chat completion succeeded" };
}

function getConfiguredChecks(): Array<() => Promise<CheckResult>> {
  const checks: Array<() => Promise<CheckResult>> = [];
  if (apiKeys.OPENROUTER_API_KEY) checks.push(testOpenRouter);
  if (apiKeys.GOOGLE_API_KEY) checks.push(testGemini);
  if (apiKeys.GROQ_API_KEY) checks.push(testGroq);
  return checks;
}

async function main(): Promise<void> {
  console.log(`Reading keys from: ${API_KEYS_FILE}`);

  const configuredChecks = getConfiguredChecks();
  if (configuredChecks.length === 0) {
    console.log("No API keys were found in API keys.txt.");
    return;
  }

  const checks = await Promise.all(configuredChecks.map((run) => run()));
  let failures = 0;

  for (const check of checks) {
    const prefix = check.ok ? "[OK]" : "[FAIL]";
    if (!check.ok) failures += 1;
    console.log(`${prefix} ${check.provider}: ${check.message}`);
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
});
