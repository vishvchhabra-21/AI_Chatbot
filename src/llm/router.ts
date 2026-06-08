import { availableProviders, buildChatModel, type ProviderName } from "./providers.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

function isRateLimitError(err: unknown): boolean {
  const e = err as any;
  const status = e?.status ?? e?.response?.status ?? e?.cause?.status;
  const msg = String(e?.message ?? "");
  return status === 429 || /rate limit|too many requests|429/i.test(msg);
}

export type ProviderFailure = {
  provider: ProviderName;
  reason: "rate_limit" | "error";
  message: string;
};

function buildNoProviderSucceededError(errors: ProviderFailure[]): Error {
  if (errors.length === 0) {
    return new Error("No LLM provider succeeded. Set at least one supported key from API keys.txt (OpenRouter, Gemini, Groq) or run Ollama locally.");
  }

  const details = errors.map(({ provider, message }) => `${provider}: ${message}`).join(" | ");

  return new Error(`No LLM provider succeeded. ${details}`);
}

function rotateProviders(providers: ProviderName[], preferredStartIndex = 0): ProviderName[] {
  if (providers.length === 0) return [];
  const normalized = ((preferredStartIndex % providers.length) + providers.length) % providers.length;
  return [...providers.slice(normalized), ...providers.slice(0, normalized)];
}

export type ChatCall = (model: BaseChatModel) => Promise<string>;

export type RoutedAnswer = {
  provider: ProviderName;
  text: string;
  hadToFallback: boolean;
  fallbackReason: "rate_limit" | "error" | null;
  failures: ProviderFailure[];
};

export async function callWithFallback(
  call: ChatCall,
  options?: { preferredStartIndex?: number; skippedProviders?: Set<ProviderName> }
): Promise<RoutedAnswer> {
  const allProviders = rotateProviders(availableProviders(), options?.preferredStartIndex ?? 0);
  const skippedProviders = options?.skippedProviders ?? new Set<ProviderName>();
  const providers = allProviders.filter((provider) => !skippedProviders.has(provider));
  const attemptOrder = providers.length > 0 ? providers : allProviders;
  const failures: ProviderFailure[] = [];

  for (const provider of attemptOrder) {
    try {
      const model = buildChatModel(provider);
      const text = await call(model);
      return {
        provider,
        text,
        hadToFallback: provider !== attemptOrder[0],
        fallbackReason: provider === attemptOrder[0] ? null : failures.at(-1)?.reason ?? "error",
        failures
      };
    } catch (err) {
      failures.push({
        provider,
        reason: isRateLimitError(err) ? "rate_limit" : "error",
        message: String((err as any)?.message ?? err)
      });
      continue;
    }
  }

  throw buildNoProviderSucceededError(failures);
}
