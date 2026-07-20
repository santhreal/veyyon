/**
 * discovery.importForeignConfig gate.
 *
 * Skills, context files (CLAUDE.md / standalone AGENTS.md), rules, and MCP
 * servers authored for OTHER AI tools stay OFF by default — veyyon runs on its
 * own instruction layers only (the system prompt, the global ~/.veyyon/AGENTS.md,
 * and the active profile's AGENTS.md). The single /settings toggle
 * `discovery.importForeignConfig` (default OFF) controls this; opting in loads
 * the foreign files as a machine-wide base layer. veyyon's own providers
 * (`native`, `veyyon-plugins`, generic transport providers) are never gated.
 *
 * The gate lives in ONE place — `isProviderEnabled` — which the capability
 * collection filter (`filterProviders`) and every UI enabled-flag consult, so
 * flipping the setting flips discovery and the settings UI in lockstep.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	getCapabilityInfo,
	getForeignProviderIds,
	initializeWithSettings,
	isForeignConfigImportEnabled,
	isProviderEnabled,
} from "@veyyon/coding-agent/capability";
import { skillCapability } from "@veyyon/coding-agent/capability/skill";
import { Settings } from "@veyyon/coding-agent/config/settings";

// Ensure the skill discovery providers (claude/codex/agents/native/...) are
// registered on the global capability registry.
import "@veyyon/coding-agent/discovery";

function applyImportSetting(value: boolean): void {
	initializeWithSettings(Settings.isolated({ "discovery.importForeignConfig": value }));
}

const NATIVE_PROVIDERS = ["native", "veyyon-plugins"];
const FOREIGN_SAMPLES = ["claude", "codex", "agents", "agents-md", "cursor", "gemini"];

afterEach(() => {
	// Restore the shipped default (foreign providers OFF) so sibling test files
	// sharing this process's global capability registry see production behavior.
	applyImportSetting(false);
});

describe("discovery.importForeignConfig", () => {
	test("ships off by default so veyyon loads only its own instruction layers", () => {
		initializeWithSettings(Settings.isolated());
		expect(isForeignConfigImportEnabled()).toBe(false);
	});

	test("opting out gates every foreign provider off while leaving veyyon-native providers on", () => {
		applyImportSetting(false);
		for (const id of FOREIGN_SAMPLES) {
			expect(isProviderEnabled(id)).toBe(false);
		}
		for (const id of NATIVE_PROVIDERS) {
			expect(isProviderEnabled(id)).toBe(true);
		}
	});

	test("opting in enables the foreign providers", () => {
		applyImportSetting(true);
		expect(isForeignConfigImportEnabled()).toBe(true);
		for (const id of FOREIGN_SAMPLES) {
			expect(isProviderEnabled(id)).toBe(true);
		}
	});

	test("the foreign set covers the known other-tool providers and excludes native ones", () => {
		const foreign = new Set(getForeignProviderIds());
		for (const id of FOREIGN_SAMPLES) {
			expect(foreign.has(id)).toBe(true);
		}
		for (const id of NATIVE_PROVIDERS) {
			expect(foreign.has(id)).toBe(false);
		}
	});

	test("the skill capability's UI enabled-flags follow the gate", () => {
		applyImportSetting(false);
		const off = getCapabilityInfo(skillCapability.id);
		const nativeOff = off?.providers.find(p => p.id === "native");
		const claudeOff = off?.providers.find(p => p.id === "claude");
		expect(nativeOff?.enabled).toBe(true);
		// `claude` registers a skill provider; when it is gated the settings UI
		// must render it disabled, not enabled.
		if (claudeOff) expect(claudeOff.enabled).toBe(false);

		applyImportSetting(true);
		const on = getCapabilityInfo(skillCapability.id);
		const claudeOn = on?.providers.find(p => p.id === "claude");
		if (claudeOn) expect(claudeOn.enabled).toBe(true);
	});
});
