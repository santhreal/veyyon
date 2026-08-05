import { describe, expect, it } from "bun:test";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * Veyyon briefly persisted a programmatic "continuity" record: a hidden
 * `compaction-continuity` custom message plus a `veyyon.continuity.v1` slot in a
 * compaction entry's `preserveData`. Both readers are gone. Transcripts written
 * while they existed must still load: the custom message is now just an unknown
 * `customType` and the preserve key is an unread extra field.
 */
describe("transcripts written by the removed continuity mechanism", () => {
	it("loads a legacy compaction-continuity custom message as an ordinary unknown custom message", () => {
		using tempDir = TempDir.createSync("@pi-legacy-continuity-message-");
		const manager = SessionManager.inMemory(tempDir.path());
		manager.appendMessage({ role: "user", content: "first request", timestamp: Date.now() });
		manager.appendCustomMessageEntry(
			"compaction-continuity",
			'<continuity-state version="1">\n## Macro contract\ntest?\n</continuity-state>',
			false,
			{ version: 1, activeObjective: { text: "test?", source: "user" } },
			"agent",
		);
		manager.appendMessage({ role: "user", content: "second request", timestamp: Date.now() });

		const context = manager.buildSessionContext();

		expect(context.messages.map(message => message.role)).toEqual(["user", "custom", "user"]);
		const custom = context.messages[1] as { role: "custom"; customType: string };
		expect(custom.customType).toBe("compaction-continuity");
	});

	it("loads a compaction entry carrying a legacy veyyon.continuity.v1 preserve slot", () => {
		using tempDir = TempDir.createSync("@pi-legacy-continuity-preserve-");
		const manager = SessionManager.inMemory(tempDir.path());
		manager.appendMessage({ role: "user", content: "dropped request", timestamp: Date.now() });
		const keptId = manager.appendMessage({ role: "user", content: "kept request", timestamp: Date.now() });
		manager.appendCompaction("Model-authored summary", undefined, keptId, 100, undefined, false, {
			"veyyon.continuity.v1": {
				version: 1,
				macroContract: { text: "test?", sourceEntryIds: [] },
				todos: [],
			},
			otherExtensionState: "keep-me",
		});

		const context = manager.buildSessionContext();

		expect(context.messages[0]).toMatchObject({ role: "compactionSummary", summary: "Model-authored summary" });
		expect(context.messages.map(message => message.role)).toEqual(["compactionSummary", "user"]);
	});
});
