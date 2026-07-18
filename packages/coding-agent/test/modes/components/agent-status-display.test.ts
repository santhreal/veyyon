/**
 * Locks the ONE-PLACE agent-status visual language: the glyph form (Agent Hub
 * roster) and the word form (transcript viewer header) must derive the SAME
 * color from the single owner for every status. This is the regression guard for
 * the pre-unification bug where the hub and viewer disagreed on status colors —
 * the hub used running→accent/idle→success and the viewer the exact reverse, so
 * an identical agent state carried opposite colors depending on which view you
 * were in.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import {
	agentStatusColor,
	agentStatusGlyph,
	agentStatusWord,
} from "@veyyon/coding-agent/modes/components/agent-status-display";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";

const ALL_STATUSES: AgentStatus[] = ["running", "idle", "parked", "aborted"];

describe("agent status display (ONE-PLACE)", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("maps each status to its canonical color", () => {
		expect(agentStatusColor("running")).toBe("accent");
		expect(agentStatusColor("idle")).toBe("success");
		expect(agentStatusColor("parked")).toBe("muted");
		expect(agentStatusColor("aborted")).toBe("error");
	});

	it("renders the glyph and word of a status in the same color", () => {
		for (const status of ALL_STATUSES) {
			const expectedAnsi = theme.getFgAnsi(agentStatusColor(status));
			expect(agentStatusGlyph(status).startsWith(expectedAnsi)).toBe(true);
			expect(agentStatusWord(status).startsWith(expectedAnsi)).toBe(true);
		}
	});

	it("renders the status name as the word body", () => {
		for (const status of ALL_STATUSES) {
			expect(Bun.stripANSI(agentStatusWord(status))).toBe(status);
		}
	});

	it("gives the four statuses four distinct colors", () => {
		const colors = new Set(ALL_STATUSES.map(agentStatusColor));
		expect(colors.size).toBe(ALL_STATUSES.length);
	});

	it("renders a non-empty visible glyph for every status", () => {
		for (const status of ALL_STATUSES) {
			expect(Bun.stripANSI(agentStatusGlyph(status)).length).toBeGreaterThan(0);
		}
	});
});
