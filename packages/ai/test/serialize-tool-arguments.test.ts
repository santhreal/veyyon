/**
 * Serializing a recorded tool call's arguments for conversation replay.
 *
 * When history is replayed to an OpenAI-compatible provider, each recorded tool
 * call's `arguments` is re-serialized into a JSON string. The field only has to
 * be a string containing JSON, so any valid JSON the model produced must be
 * preserved. An earlier version returned `{}` for a string that parsed to
 * anything other than an object (a JSON array or scalar), and also for a string
 * that did not parse at all, both silently. Dropping valid JSON corrupts the
 * model's view of its own history: it sees it called the tool with no
 * arguments. These tests pin that valid JSON survives round-trip and that only
 * a genuinely unparseable string falls back to `{}`, loudly (Law 10).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { serializeToolArguments } from "@veyyon/ai/providers/openai-completions";
import { logger } from "@veyyon/utils";

describe("serializeToolArguments", () => {
	describe("valid input is preserved as canonical JSON", () => {
		it("stringifies an object record", () => {
			expect(serializeToolArguments({ path: "a.ts", line: 3 })).toBe('{"path":"a.ts","line":3}');
		});

		it("round-trips a JSON-object string", () => {
			expect(serializeToolArguments('{"path":"a.ts"}')).toBe('{"path":"a.ts"}');
		});

		it("preserves a JSON-array string instead of dropping it to {}", () => {
			// THE regression: a valid JSON array is still what the model produced and
			// is a valid `arguments` string, so it must survive rather than become {}.
			expect(serializeToolArguments("[1, 2, 3]")).toBe("[1,2,3]");
		});

		it("preserves a JSON-scalar string", () => {
			expect(serializeToolArguments('"hello"')).toBe('"hello"');
			expect(serializeToolArguments("42")).toBe("42");
		});

		it("canonicalizes whitespace in a valid JSON string", () => {
			// Re-stringifying is what makes the output canonical regardless of how the
			// stored string was spaced.
			expect(serializeToolArguments('{ "a" :  1 }')).toBe('{"a":1}');
		});
	});

	describe("empty and non-string inputs default to an empty object", () => {
		it.each([
			["", "an empty string"],
			["   ", "whitespace only"],
		])("returns {} for %s (%s)", input => {
			expect(serializeToolArguments(input)).toBe("{}");
		});

		it("returns {} for a non-string, non-record value", () => {
			expect(serializeToolArguments(undefined)).toBe("{}");
			expect(serializeToolArguments(null)).toBe("{}");
			expect(serializeToolArguments(42)).toBe("{}");
		});
	});

	describe("an unparseable string falls back to {} but is surfaced", () => {
		let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

		beforeEach(() => {
			warnings = [];
			vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
				warnings.push({ message, fields: fields ?? {} });
			});
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		const drops = (): Array<Record<string, unknown>> =>
			warnings
				.filter(w => w.message.startsWith("A recorded tool call had unparseable arguments"))
				.map(w => w.fields);

		it("returns {} for a string that is not JSON", () => {
			// A strict provider rejects a non-JSON arguments string, so the {} safety
			// net stays; only its silence is fixed.
			expect(serializeToolArguments("{not valid json")).toBe("{}");
		});

		it("logs the drop rather than swallowing it", () => {
			// The original silence left the model's history quietly wrong with nothing
			// pointing at why.
			serializeToolArguments("{not valid json");

			expect(drops()).toHaveLength(1);
		});

		it("names the tool when it is known, so the log points somewhere", () => {
			serializeToolArguments("{not valid json", "read_file");

			expect(drops()[0]?.tool).toBe("read_file");
		});

		it("does not warn for valid JSON, so a warning always means a real drop", () => {
			// Anti-vacuity: the valid paths must stay quiet or the log fills with noise
			// and the real warning stops being read.
			serializeToolArguments("[1,2,3]");
			serializeToolArguments('{"a":1}');
			serializeToolArguments("");

			expect(drops()).toHaveLength(0);
		});
	});
});
