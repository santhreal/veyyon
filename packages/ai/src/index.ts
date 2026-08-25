// Fills the usage-provider registry that `auth-storage.ts` consults. The credential store no
// longer imports the eleven backends itself, so SOMETHING has to, and the barrel is where every
// consumer of `AuthStorage` from this package already arrives. Without it the registry refuses to
// answer rather than reporting no usage for everything -- see `usage/registry.ts`.
import "./usage/defaults";

export { type Type, type } from "arktype";
export { type ZodType, z } from "zod/v4";
export * from "./api-registry";
export type * from "./auth-broker";
export type { AuthGatewayBootOptions, ModelResolver } from "./auth-gateway/server";
export * from "./auth-gateway/types";
export * from "./auth-retry";
export * from "./auth-storage";
export * from "./env-api-key";
export * from "./error/rate-limit";
export * from "./instrumentation";
export * from "./provider-details";
export type * from "./providers/anthropic";
export type * from "./providers/anthropic-client";
export type * from "./providers/azure-openai-responses";
export type * from "./providers/cursor";
export type * from "./providers/gitlab-duo";
export type * from "./providers/gitlab-duo-workflow";
export type * from "./providers/google";
export type * from "./providers/google-gemini-cli";
export type * from "./providers/google-vertex";
export type * from "./providers/kimi";
export type * from "./providers/mock";
export type * from "./providers/ollama";
export type * from "./providers/openai-codex-responses";
export type * from "./providers/openai-completions";
export type * from "./providers/openai-responses";
export type * from "./providers/synthetic";
export * from "./registry";
export * from "./stream";
export * from "./types";
export * from "./usage";
export * from "./usage/claude";
export * from "./usage/cursor";
export * from "./usage/gemini";
export * from "./usage/github-copilot";
export * from "./usage/google-antigravity";
export * from "./usage/kimi";
export * from "./usage/minimax-code";
export * from "./usage/ollama";
export * from "./usage/openai-codex";
export * from "./usage/openai-codex-reset";
export * from "./usage/opencode-go";
export * from "./usage/zai";
export * from "./utils/anthropic-auth";
export * from "./utils/event-stream";
export * from "./utils/message-text";
export * from "./utils/openrouter-headers";
export * from "./utils/retry";
export * from "./utils/schema";
export * from "./utils/thinking-loop";
export * from "./utils/tool-call-loop-guard";
export * from "./utils/validation";
