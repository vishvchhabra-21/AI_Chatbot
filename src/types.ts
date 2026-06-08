export type ChatRole = "system" | "user" | "assistant";

export type WsClientMessage =
  | { type: "user_message"; text: string }
  | { type: "reset" };

export type WsServerMessage =
  | { type: "assistant_message"; text: string; suggestions?: string[] }
  | { type: "status"; text: string }
  | { type: "error"; text: string };
