/**
 * Locks the ONE-PLACE agent-status visual language: the glyph form (Agent Control Center
 * roster) and the word form (transcript viewer header) must derive the SAME
 * color from the single owner for every status. This is the regression guard for
 * the pre-unification bug where the hub and viewer disagreed on status colors —
 * the hub used running→accent/idle→success and the viewer the exact reverse, so
 * an identical agent state carried opposite colors depending on which view you
 * were in.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import {
	type AgentDisplayState,
	agentDisplayState,
	agentStatusColor,
	agentStatusGlyph,
	agentStatusWord,
} from "@veyyon/coding-agent/modes/components/agent-status-display";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { useFullColor } from "../../helpers/theme-assertions";

/**
 * Every state a surface may draw, which is finer than `AgentStatus`: `blocked`
 * and `waiting` are derived, and they exist precisely because the raw status
 * cannot tell a stopped-on-a-person or stopped-on-a-peer agent from a busy or a
 * finished one.
 */
const ALL_STATUSES: AgentDisplayState[] = ["running", "blocked", "idle", "waiting", "parked", "aborted"];

describe("agent status display (ONE-PLACE)", () => {
	useFullColor();

	beforeAll(async () => {
		await initTheme();
	});

	it("maps each status to its canonical color", () => {
		expect(agentStatusColor("running")).toBe("accent");
		expect(agentStatusColor("blocked")).toBe("warning");
		expect(agentStatusColor("idle")).toBe("success");
		expect(agentStatusColor("waiting")).toBe("link");
		expect(agentStatusColor("parked")).toBe("muted");
		expect(agentStatusColor("aborted")).toBe("error");
	});

	/**
	 * The derivation itself, which every surface goes through so none of them can
	 * disagree about when an agent counts as blocked or waiting.
	 *
	 * The last case is the one that bites: `waitingOnPeer` is written at the end
	 * of a run and left in place while the agent is woken again, so a surface
	 * reading it on a `running` row would report the reason it stopped LAST time
	 * as the reason it is stopped now.
	 */
	it("derives blocked and waiting from the ref, with the approval winning", () => {
		expect(agentDisplayState({ status: "running" })).toBe("running");
		expect(agentDisplayState({ status: "running", blockedOnApproval: true })).toBe("blocked");
		expect(agentDisplayState({ status: "parked", waitingOnPeer: true })).toBe("waiting");
		expect(agentDisplayState({ status: "idle", waitingOnPeer: true })).toBe("waiting");
		expect(agentDisplayState({ status: "parked", waitingOnPeer: false })).toBe("parked");
		expect(agentDisplayState({ status: "running", waitingOnPeer: true })).toBe("running");
		expect(agentDisplayState({ status: "parked", waitingOnPeer: true, blockedOnApproval: true })).toBe("blocked");
	});

	it("renders the glyph and word of a status in the same color", () => {
		for (const status of ALL_STATUSES) {
			const expectedAnsi = theme.getFgAnsi(agentStatusColor(status));
			expect(agentStatusGlyph(status).startsWith(expectedAnsi)).toBe(true);
			expect(agentStatusWord(status).startsWith(expectedAnsi)).toBe(true);
		}
	});

	it("renders the state name as the word body", () => {
		for (const status of ALL_STATUSES) {
			expect(Bun.stripANSI(agentStatusWord(status))).toBe(status);
		}
	});

	it("gives every display state its own color", () => {
		const colors = new Set(ALL_STATUSES.map(agentStatusColor));
		expect(colors.size).toBe(ALL_STATUSES.length);
	});

	it("renders a non-empty visible glyph for every status", () => {
		for (const status of ALL_STATUSES) {
			expect(Bun.stripANSI(agentStatusGlyph(status)).length).toBeGreaterThan(0);
		}
	});
});
