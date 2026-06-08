import type { ProviderName } from "./llm/providers.js";
import type { KnowledgeBase } from "./rag.js";

export type SessionStage = "awaiting_url" | "crawling" | "ready";

export type ChatSessionState = {
  stage: SessionStage;
  seedUrl: string | null;
  kb: KnowledgeBase | null;
  suggestions: string[];
  nextProviderIndex: number;
  providerCooldowns: Partial<Record<ProviderName, number>>;
};

export function createNewSession(): ChatSessionState {
  return { stage: "awaiting_url", seedUrl: null, kb: null, suggestions: [], nextProviderIndex: 0, providerCooldowns: {} };
}

export function resetSession(state: ChatSessionState): void {
  state.stage = "awaiting_url";
  state.seedUrl = null;
  state.kb = null;
  state.suggestions = [];
  state.nextProviderIndex = 0;
  state.providerCooldowns = {};
}
