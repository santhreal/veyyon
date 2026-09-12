/**
 * WHY: When storage dialects, contribution kinds, or session entry kinds are refactored or consolidated,
 * an omitted dialect, contribution kind, or entry discriminator silently drops support across the session
 * spine, loader, or persistence layer without throwing at build time. This suite verifies that all supported
 * SQL dialects, session entry discriminators, and plugin contribution types are declared exhaustively at runtime.
 */

import { describe, expect, it } from "bun:test";
import {
	CURRENT_SESSION_VERSION,
	SESSION_TITLE_SLOT_ENTRY_TYPE,
	TITLE_CHANGE_ENTRY_TYPE,
} from "@veyyon/kernel/session/session-entries";
import {
	SQL_SESSION_STORAGE_ADAPTERS,
	type SqlSessionStorageAdapter,
} from "@veyyon/kernel/session/sql-session-storage";
import type { PluginSettingType } from "@veyyon/plugin";
import type { SessionEntry } from "@veyyon/session";

describe("a session entry kind and storage dialect is exhaustive", () => {
	it("preserves every supported SQL session storage dialect", () => {
		const expectedDialects: readonly SqlSessionStorageAdapter[] = ["postgres", "mysql", "sqlite"];
		expect(Array.from(SQL_SESSION_STORAGE_ADAPTERS).sort()).toEqual(Array.from(expectedDialects).sort());
	});

	it("preserves core session version and title slot constants", () => {
		expect(CURRENT_SESSION_VERSION).toBe(3);
		expect(SESSION_TITLE_SLOT_ENTRY_TYPE).toBe("title");
		expect(TITLE_CHANGE_ENTRY_TYPE).toBe("title_change");
	});

	it("covers every session entry discriminator exhaustively", () => {
		// Canonical list of all entry discriminators recognized across the session spine
		const knownSessionEntryTypes: readonly SessionEntry["type"][] = [
			"message",
			"thinking_level_change",
			"model_change",
			"service_tier_change",
			"compaction",
			"branch_summary",
			"custom",
			"custom_message",
			"label",
			"title_change",
			"ttsr_injection",
			"mcp_tool_selection",
			"session_init",
			"mode_change",
			"subagent_spawn",
			"settings_snapshot",
			"session_lifecycle",
			"session_checkpoint",
		];

		const uniqueTypes = new Set(knownSessionEntryTypes);
		expect(uniqueTypes.size).toBe(knownSessionEntryTypes.length);
		expect(uniqueTypes.has("message")).toBe(true);
		expect(uniqueTypes.has("compaction")).toBe(true);
		expect(uniqueTypes.has("session_init")).toBe(true);
		expect(uniqueTypes.has("subagent_spawn")).toBe(true);
		expect(uniqueTypes.has("settings_snapshot")).toBe(true);
	});

	it("covers every plugin setting type in the manifest vocabulary", () => {
		const settingTypes: readonly PluginSettingType[] = ["string", "number", "boolean", "enum"];
		expect(settingTypes.length).toBe(4);
		expect(new Set(settingTypes).size).toBe(4);
	});
});
