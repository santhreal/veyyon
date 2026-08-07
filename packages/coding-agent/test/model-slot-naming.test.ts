import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MODEL_SLOT,
	DEFAULT_MODEL_SLOT_ALIASES,
	getKnownRoleIds,
	isDefaultModelSlot,
	MODEL_ROLE_IDS,
	resolveModelSlot,
} from "@veyyon/coding-agent/config/model-roles";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { DEFAULT_MODEL_SETTING_ID } from "@veyyon/coding-agent/modes/components/settings-defs";

/**
 * The slot holding "the model you are working with" has ONE name.
 *
 * It had accumulated three spellings — `default` in storage, `interactive` as
 * `setModel`'s parameter default, and `defaultModel` as the settings row id — with
 * the translation written inline at each call site. One line in `setModel` stored
 * `default` while logging `interactive` for the same write, so a session log entry
 * could not be matched to the setting it changed.
 * These cases pin the single translation point and the storage key it produces.
 */

describe("resolving a role argument to a slot", () => {
	it("collapses every accepted spelling of the default slot to the storage key", () => {
		for (const alias of DEFAULT_MODEL_SLOT_ALIASES) {
			expect(resolveModelSlot(alias)).toBe(DEFAULT_MODEL_SLOT);
		}
		expect(resolveModelSlot("interactive")).toBe("default");
	});

	it("passes every named role through untouched", () => {
		// A translation point that rewrote real roles would silently move a model
		// assignment from, say, `plan` into the default slot.
		for (const role of MODEL_ROLE_IDS) {
			if (role === DEFAULT_MODEL_SLOT) continue;
			expect(resolveModelSlot(role)).toBe(role);
		}
		expect(resolveModelSlot("my-custom-role")).toBe("my-custom-role");
	});

	it("recognizes the aliases and nothing else", () => {
		expect(isDefaultModelSlot("default")).toBe(true);
		expect(isDefaultModelSlot("interactive")).toBe(true);
		expect(isDefaultModelSlot("plan")).toBe(false);
		expect(isDefaultModelSlot("")).toBe(false);
		// The settings ROW ID is a different namespace and must not resolve as a role.
		expect(isDefaultModelSlot(DEFAULT_MODEL_SETTING_ID)).toBe(false);
	});

	it("keeps the storage key equal to the historical `default` role name", () => {
		// Changing this value orphans every existing `modelRoles.default` on disk.
		expect(DEFAULT_MODEL_SLOT).toBe("default");
	});
});

describe("enumerating configured roles", () => {
	it("hides the default slot from role pickers", () => {
		// It is not a selectable role: it holds the session model, which `/model`
		// changes directly.
		const settings = Settings.isolated({ modelRoles: { default: "anthropic/claude-sonnet-4-5" } });
		expect(getKnownRoleIds(settings)).not.toContain(DEFAULT_MODEL_SLOT);
	});

	it("still lists a custom role a user happened to name `interactive`", () => {
		// Enumeration compares against the storage key, not the alias set: storage
		// only ever holds the canonical key, so treating an alias as the slot here
		// would silently drop a real custom role from every picker.
		const settings = Settings.isolated({ modelRoles: { interactive: "anthropic/claude-sonnet-4-5" } });
		expect(getKnownRoleIds(settings)).toContain("interactive");
	});

	it("lists a configured custom role alongside the built-ins", () => {
		const settings = Settings.isolated({ modelRoles: { reviewer: "openai/gpt-5" } });
		const roles = getKnownRoleIds(settings);
		expect(roles).toContain("reviewer");
		expect(roles).toContain("plan");
	});
});
