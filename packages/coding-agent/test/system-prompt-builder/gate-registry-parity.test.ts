/**
 * The prompt gate registry is complete and consistent.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. PROMPT_GATES maps settings to template variables and tracks whether
 * flipping a setting live-rebuilds the system prompt. A missing or
 * inconsistent gate means the prompt silently disagrees with the settings.
 * This suite pins every gate's setting, variables, liveness kind, and the
 * derived lists (LIVE, FROZEN, all variables).
 */
import { describe, expect, it } from "bun:test";
import {
	PROMPT_GATES,
	PROMPT_GATE_SETTINGS,
	LIVE_PROMPT_GATE_SETTINGS,
	FROZEN_PROMPT_GATE_SETTINGS,
	PROMPT_GATE_VARIABLES,
	isLivePromptGate,
	promptGateFor,
	frozenGateNotice,
} from "@veyyon/coding-agent/system-prompt-builder/gate-registry";

describe("prompt gate registry", () => {
	it("PROMPT_GATES is non-empty", () => {
		expect(PROMPT_GATES.length).toBeGreaterThan(0);
	});

	it("every gate has a setting, variables array, renders string, and liveness", () => {
		for (const gate of PROMPT_GATES) {
			expect(typeof gate.setting).toBe("string");
			expect(gate.setting.length).toBeGreaterThan(0);
			expect(Array.isArray(gate.variables)).toBe(true);
			expect(typeof gate.renders).toBe("string");
			expect(gate.renders.length).toBeGreaterThan(0);
			expect(gate.liveness).toBeDefined();
			expect(["live", "frozen-by-design", "frozen-by-placement"]).toContain(gate.liveness.kind);
		}
	});

	it("PROMPT_GATE_SETTINGS matches the gates", () => {
		expect(PROMPT_GATE_SETTINGS).toEqual(PROMPT_GATES.map(g => g.setting));
	});

	it("every gate setting is unique", () => {
		const settings = PROMPT_GATES.map(g => g.setting);
		expect(new Set(settings).size).toBe(settings.length);
	});

	it("LIVE and FROZEN partition the full gate list", () => {
		const live = new Set(LIVE_PROMPT_GATE_SETTINGS);
		const frozen = new Set(FROZEN_PROMPT_GATE_SETTINGS);
		// No overlap
		for (const s of live) expect(frozen.has(s)).toBe(false);
		// Union equals full set
		const union = new Set([...live, ...frozen]);
		expect(union.size).toBe(PROMPT_GATE_SETTINGS.length);
	});

	it("frozen gates have a because reason", () => {
		for (const gate of PROMPT_GATES) {
			if (gate.liveness.kind !== "live") {
				expect(gate.liveness.because).toBeDefined();
				expect(gate.liveness.because!.length).toBeGreaterThan(0);
			}
		}
	});

	it("PROMPT_GATE_VARIABLES is the unique union of all gate variables", () => {
		const allVars = [...new Set(PROMPT_GATES.flatMap(g => [...g.variables]))].sort();
		expect([...PROMPT_GATE_VARIABLES].sort()).toEqual(allVars);
	});

	it("isLivePromptGate returns true for live settings and false for frozen", () => {
		for (const setting of LIVE_PROMPT_GATE_SETTINGS) {
			expect(isLivePromptGate(setting)).toBe(true);
		}
		for (const setting of FROZEN_PROMPT_GATE_SETTINGS) {
			expect(isLivePromptGate(setting)).toBe(false);
		}
	});

	it("promptGateFor returns the gate for a known setting and undefined for unknown", () => {
		for (const gate of PROMPT_GATES) {
			expect(promptGateFor(gate.setting)).toBe(gate);
		}
		expect(promptGateFor("nonexistent.setting")).toBeUndefined();
	});

	it("frozenGateNotice returns a reason for frozen gates and undefined for live", () => {
		for (const setting of FROZEN_PROMPT_GATE_SETTINGS) {
			const notice = frozenGateNotice(setting);
			expect(typeof notice).toBe("string");
			expect(notice!.length).toBeGreaterThan(0);
		}
		for (const setting of LIVE_PROMPT_GATE_SETTINGS) {
			expect(frozenGateNotice(setting)).toBeUndefined();
		}
	});
});
