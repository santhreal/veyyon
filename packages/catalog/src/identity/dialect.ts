import { modelFamilyToken } from "./family";

/**
 * Every tool-call dialect, and the ONE place the set is written down.
 *
 * The list owns the set and {@link Dialect} is derived from it, rather than a union
 * owning it and a list restating it. There was no list at all: the union was the only
 * statement of the set, so nothing could enumerate dialects at runtime and a check
 * that wanted to ask "does every dialect ship a format guide" had to hand-write the
 * twelve names a second time, which is a copy that goes stale the first time a
 * dialect is added.
 *
 * `as const` without a `readonly Dialect[]` annotation on purpose: the annotation
 * would widen each entry to `Dialect` and leave the type below deriving from itself.
 */
export const DIALECTS = [
	"glm",
	"hermes",
	"kimi",
	"xml",
	"anthropic",
	"deepseek",
	"harmony",
	"qwen3",
	"gemini",
	"gemma",
	"minimax",
	"pi-native",
] as const;

/** One tool-call dialect. Derived from {@link DIALECTS}, which is the set's owner. */
export type Dialect = (typeof DIALECTS)[number];

export const FALLBACK_DIALECT: Dialect = "xml";

export function preferredDialect(modelId: string): Dialect {
	switch (modelFamilyToken(modelId)) {
		case "anthropic":
			return "anthropic";
		case "glm":
			return "glm";
		case "gemini":
			return "gemini";
		case "gemma":
			return "gemma";
		case "kimi":
			return "kimi";
		case "qwen":
			return "qwen3";
		case "deepseek":
			return "deepseek";
		case "minimax":
			return "minimax";
		case "openai":
		case "gpt-oss":
			return "harmony";
		default:
			return FALLBACK_DIALECT;
	}
}
