import { describe, expect, it } from "bun:test";
import { createOpenAICodexCompatibilityMetadata } from "@veyyon/ai/providers/openai-codex-responses";
import { OPENAI_HEADERS } from "@veyyon/catalog/wire/codex";

/**
 * Caller-supplied `clientMetadata` is merged into the Codex turn-metadata header
 * after the reserved keys are removed. The reserved-key check must test OWN
 * membership of the reserved set, not a bare `RESERVED[key]` index read: the set
 * is a plain object, so `RESERVED["toString"]` resolves the inherited
 * `Object.prototype.toString` (a function, truthy) and a caller metadata field
 * literally named `toString`/`valueOf`/`constructor`/`hasOwnProperty` would be
 * mistaken for a reserved key and SILENTLY DROPPED from the outgoing request.
 *
 * These pin that a prototype-named custom field survives into the turn-metadata
 * header while genuinely reserved keys are still stripped (a caller cannot spoof
 * `session_id`).
 */
function parseTurnMetadata(clientMetadata: Record<string, string>): Record<string, unknown> {
	const result = createOpenAICodexCompatibilityMetadata({
		requestKind: "turn",
		sessionId: "session-own-key-test",
		clientMetadata,
	});
	const raw = result.headers[OPENAI_HEADERS.TURN_METADATA];
	expect(typeof raw).toBe("string");
	return JSON.parse(raw as string) as Record<string, unknown>;
}

describe("Codex client metadata reserved-key filtering uses own-property semantics", () => {
	it("preserves custom metadata fields whose names collide with prototype members", () => {
		const parsed = parseTurnMetadata({
			toString: "keep-tostring",
			valueOf: "keep-valueof",
			hasOwnProperty: "keep-hasown",
			customField: "keep-custom",
		});

		// Read metadata by string key name on purpose: these keys collide with
		// prototype method names (toString/valueOf/hasOwnProperty), and accessing
		// them as data via a variable key documents that intent and avoids the
		// useLiteralKeys lint that a `.toString` dot access would trip.
		const value = (key: string): unknown => (parsed as Record<string, unknown>)[key];
		expect(Object.hasOwn(parsed, "toString")).toBe(true);
		expect(value("toString")).toBe("keep-tostring");
		expect(value("valueOf")).toBe("keep-valueof");
		expect(value("hasOwnProperty")).toBe("keep-hasown");
		expect(value("customField")).toBe("keep-custom");
	});

	it("still strips a genuinely reserved key so a caller cannot override identity", () => {
		const parsed = parseTurnMetadata({
			session_id: "attacker-supplied",
			customField: "kept",
		});
		// session_id is reserved: the identity value wins, not the caller's.
		expect(parsed.session_id).toBe("session-own-key-test");
		expect(parsed.customField).toBe("kept");
	});
});
