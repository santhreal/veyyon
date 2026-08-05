/**
 * Locks out the bare `catch {}` in `AgentRegistry#emit`.
 *
 * The dispatch loop must not stop when one listener throws, and that part was
 * always right. What was wrong is that the throw went nowhere: a listener that
 * throws is a bug in the listener, not an expected condition, and it keeps its
 * subscription. Whatever it renders (the `irc list` roster, a status line, a
 * dashboard row) silently stops tracking reality from that event onward, with
 * nothing in the logs tying the stale view to the exception that caused it.
 *
 * If this regresses, a broken observer becomes invisible again: the roster just
 * quietly goes stale and the only symptom is a UI that disagrees with the
 * registry.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AgentRegistry, type RegistryEvent } from "@veyyon/coding-agent/registry/agent-registry";
import { logger } from "@veyyon/utils";

let registry: AgentRegistry;
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	registry = AgentRegistry.global();
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function registerOne(id: string): void {
	registry.register({
		id,
		displayName: id,
		kind: "main",
		session: null,
		sessionFile: `/transcripts/${id}.jsonl`,
		scope: "session-a",
	});
}

describe("A registry listener that throws is reported", () => {
	test("warns, naming the event the listener missed", () => {
		registry.onChange(() => {
			throw new Error("renderer blew up");
		});

		registerOne("Main");

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("listener threw");
		expect(warnings[0]?.fields.event).toBe("registered");
		expect(String(warnings[0]?.fields.error)).toContain("renderer blew up");
	});

	/**
	 * The behavior that was already correct and must be preserved: one broken
	 * listener must not cost the healthy ones their events.
	 */
	test("still delivers the event to the other listeners", () => {
		const seen: RegistryEvent["type"][] = [];
		registry.onChange(() => {
			throw new Error("renderer blew up");
		});
		registry.onChange(event => {
			seen.push(event.type);
		});

		registerOne("Main");

		expect(seen).toEqual(["registered"]);
	});

	/** A healthy listener must not produce a warning. */
	test("says nothing when every listener returns", () => {
		registry.onChange(() => {});

		registerOne("Main");

		expect(warnings).toEqual([]);
	});
});
