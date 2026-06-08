import { env } from "../config.js";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export type ProviderName = "openrouter" | "gemini" | "groq" | "ollama";

export function availableProviders(): ProviderName[] {
  const providers: ProviderName[] = [];
  if (env.OPENROUTER_API_KEY) providers.push("openrouter");
  if (env.GOOGLE_API_KEY) providers.push("gemini");
  if (env.GROQ_API_KEY) providers.push("groq");
  if (env.OLLAMA_BASE_URL) providers.push("ollama");
  return providers;
}

export function buildChatModel(provider: ProviderName): BaseChatModel {
  switch (provider) {
    case "openrouter":
      if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
      return new ChatOpenAI({
        apiKey: env.OPENROUTER_API_KEY,
        configuration: {
          baseURL: env.OPENROUTER_BASE_URL,
          defaultHeaders: {
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "Website Chatbot"
          }
        },
        model: env.OPENROUTER_MODEL,
        temperature: 0.5
      });
    case "gemini":
      if (!env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not set");
      return new ChatGoogleGenerativeAI({
        apiKey: env.GOOGLE_API_KEY,
        model: env.GEMINI_MODEL,
        temperature: 0.5
      });
    case "groq":
      if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
      return new ChatOpenAI({
        apiKey: env.GROQ_API_KEY,
        configuration: {
          baseURL: env.GROQ_BASE_URL
        },
        model: env.GROQ_MODEL,
        temperature: 0.5
      });
    case "ollama":
      return new ChatOllama({
        baseUrl: env.OLLAMA_BASE_URL,
        model: env.OLLAMA_MODEL,
        temperature: 0.5
      });
  }
}

