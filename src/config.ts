import "dotenv/config";
import fs from "fs";
import path from "path";
import { z } from "zod";

export type ApiKeyFields = {
  OPENROUTER_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  GROQ_API_KEY?: string;
};

export const API_KEYS_FILE = path.resolve(process.cwd(), "API keys.txt");

function normalizeApiKeyLabel(label: string): keyof ApiKeyFields | null {
  const normalized = label.trim().toLowerCase();
  if (normalized === "openrouter" || normalized === "open router") return "OPENROUTER_API_KEY";
  if (normalized === "gemini" || normalized === "google" || normalized === "google gemini") return "GOOGLE_API_KEY";
  if (normalized === "groq") return "GROQ_API_KEY";
  return null;
}

export function readApiKeysFromTxt(filePath: string = API_KEYS_FILE): ApiKeyFields {
  if (!fs.existsSync(filePath)) return {};

  const raw = fs.readFileSync(filePath, "utf8");
  const keys: ApiKeyFields = {};

  for (const line of raw.split(/\r?\n/g).map((value) => value.trim()).filter(Boolean)) {
    const idx = line.indexOf(" - ");
    if (idx === -1) continue;

    const keyName = normalizeApiKeyLabel(line.slice(0, idx));
    const value = line.slice(idx + 3).trim();
    if (!keyName || !value) continue;

    keys[keyName] = value;
  }

  return keys;
}

export const apiKeys = readApiKeysFromTxt();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("openrouter/auto"),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),

  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),

  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),

  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("qwen2.5-coder:7b"),

  CRAWL_MAX_DEPTH: z.coerce.number().int().positive().default(3),
  CRAWL_MAX_PAGES: z.coerce.number().int().positive().default(100),
  CRAWL_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  CRAWL_CONCURRENCY: z.coerce.number().int().positive().default(4)
});

export type Env = z.infer<typeof EnvSchema>;

const {
  OPENROUTER_API_KEY: _openrouterApiKey,
  GOOGLE_API_KEY: _googleApiKey,
  GROQ_API_KEY: _groqApiKey,
  ...nonKeyEnv
} = process.env;

export const env: Env = EnvSchema.parse({
  ...nonKeyEnv,
  ...apiKeys
});
