/**
 * Builtin / menu categories — BUILTIN_SLASH_COMMAND_CATEGORIES is the ONE
 * owner of command grouping (ONE PLACE law). These tests keep the map and the
 * registry from drifting apart: a new builtin added without a category would
 * silently render ungrouped at the bottom of the browse menu, and a stale map
 * key would claim a command that no longer exists.
 *
 * Locks:
 *  1. Every builtin command is categorized (no silent "ungrouped" builtins).
 *  2. Every map key names a real builtin (no dead entries as the registry
 *     evolves).
 *  3. The category actually flows into the TUI command objects that autocomplete
 *     consumes — the map is wiring, not decoration.
 *  4. The category vocabulary stays a small closed set; a typo like "sesion"
 *     would mint a surprise header instead of joining an existing group.
 */
import { describe, expect, it } from "bun:test";
import {
	BUILTIN_SLASH_COMMAND_CATEGORIES,
	BUILTIN_SLASH_COMMAND_CATEGORY_ORDER,
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMANDS,
} from "../../src/slash-commands/builtin-registry";

const KNOWN_CATEGORIES = new Set(["setup", "modes", "model", "share", "workspace", "context", "session", "info"]);

describe("builtin slash-command categories", () => {
	it("assigns a category to every builtin command", () => {
		const uncategorized = BUILTIN_SLASH_COMMAND_DEFS.filter(cmd => !BUILTIN_SLASH_COMMAND_CATEGORIES[cmd.name]).map(
			cmd => cmd.name,
		);
		expect(uncategorized).toEqual([]);
	});

	it("has no map entry for a command that does not exist", () => {
		const names = new Set(BUILTIN_SLASH_COMMAND_DEFS.map(cmd => cmd.name));
		const stale = Object.keys(BUILTIN_SLASH_COMMAND_CATEGORIES).filter(name => !names.has(name));
		expect(stale).toEqual([]);
	});

	it("wires the category onto the materialized TUI command objects", () => {
		for (const cmd of BUILTIN_SLASH_COMMANDS) {
			expect(cmd.category).toBe(BUILTIN_SLASH_COMMAND_CATEGORIES[cmd.name]);
		}
		// Spot-check concrete values so a wholesale map swap cannot pass.
		const byName = new Map(BUILTIN_SLASH_COMMANDS.map(cmd => [cmd.name, cmd]));
		expect(byName.get("plan")?.category).toBe("modes");
		expect(byName.get("model")?.category).toBe("model");
		expect(byName.get("share")?.category).toBe("share");
		expect(byName.get("new")?.category).toBe("session");
		expect(byName.get("settings")?.category).toBe("setup");
	});

	/** The deliberate browse sequence and the category vocabulary must stay in
	 * lockstep: an order entry for a dead category silently no-ops, and a
	 * category missing from the order falls back to registry-accident
	 * placement — both are drift, both fail here. */
	it("orders exactly the category vocabulary, each category once", () => {
		const used = new Set(Object.values(BUILTIN_SLASH_COMMAND_CATEGORIES));
		expect([...BUILTIN_SLASH_COMMAND_CATEGORY_ORDER].sort()).toEqual([...used].sort());
		expect(new Set(BUILTIN_SLASH_COMMAND_CATEGORY_ORDER).size).toBe(BUILTIN_SLASH_COMMAND_CATEGORY_ORDER.length);
		// Session control leads the browse view by design.
		expect(BUILTIN_SLASH_COMMAND_CATEGORY_ORDER[0]).toBe("session");
	});

	it("uses only the closed category vocabulary", () => {
		const offVocabulary = Object.entries(BUILTIN_SLASH_COMMAND_CATEGORIES).filter(
			([, category]) => !KNOWN_CATEGORIES.has(category),
		);
		expect(offVocabulary).toEqual([]);
	});
});
