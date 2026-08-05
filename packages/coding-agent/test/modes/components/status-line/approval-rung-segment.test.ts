/**
 * The status line always names the approval rung in force.
 *
 * WHY THIS SUITE EXISTS. The `mode` segment used to render nothing at all when
 * no special mode was active, and the autonomy rung lived nowhere on screen.
 * An operator running with `ask` and an operator running with `yolo` saw the
 * identical status line, so the honest reading of the product was that it had
 * no permission system. These cases pin the rung to the segment: visible in the
 * ordinary case, exact for every rung, and correctly SUPPRESSED in the two
 * places where naming the configured rung would state the opposite of what is
 * being enforced (the `/yolo` bypass and an active plan session).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SEGMENTS } from "@veyyon/coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@veyyon/coding-agent/modes/components/status-line/types";
import { getThemeByName, setThemeInstance, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AUTONOMY_LABEL } from "@veyyon/coding-agent/tools/approval-modes";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

interface ModeOverrides {
	/** Configured `tools.approvalMode`; omit to leave it unset. */
	approvalMode?: string | undefined;
	unsetApprovalMode?: boolean;
	/**
	 * What `--yolo` or an active plan session forces, when it differs from the
	 * configured value. The segment names the ENFORCED rung, so this is what it
	 * must render.
	 */
	enforcedMode?: string;
	bypassed?: boolean;
	planMode?: { enabled: boolean; paused: boolean } | null;
	loopMode?: { enabled: boolean } | null;
	vibeMode?: { enabled: boolean } | null;
}

function makeContext(over: ModeOverrides): SegmentContext {
	const configured = over.unsetApprovalMode ? undefined : over.approvalMode;
	const session = {
		settings: {
			get: (path: string) => (path === "tools.approvalMode" ? configured : undefined),
		},
		// The segment reads the rung the session is ENFORCING, not the stored
		// setting, because `--yolo` and plan mode both outrank the stored value
		// and neither is visible in it. `AgentSession.effectiveApprovalMode`
		// applies exactly this resolution; the stub mirrors it.
		effectiveApprovalMode: () => over.enforcedMode ?? configured,
		isApprovalBypassed: () => over.bypassed === true,
	} as unknown as AgentSession;

	return {
		session,
		activeRepo: null,
		width: 120,
		options: {},
		compactThinkingLevel: false,
		planMode: over.planMode ?? null,
		prewalk: null,
		loopMode: over.loopMode ?? null,
		goalMode: null,
		vibeMode: over.vibeMode ?? null,
		collab: null,
	} as unknown as SegmentContext;
}

/** Render the `mode` segment and return `{ visible, text }` with SGR removed. */
function renderMode(over: ModeOverrides): { visible: boolean; text: string } {
	const rendered = SEGMENTS.mode.render(makeContext(over));
	return { visible: rendered.visible, text: stripAnsi(rendered.content) };
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("the approval rung in the mode segment", () => {
	/**
	 * THE REGRESSION. With no mode active the segment reported `visible: false`
	 * and an empty string, which is how the rung became invisible. Each rung is
	 * checked against the shared `AUTONOMY_LABEL` map so the status line and
	 * `/permissions` can never spell the same rung two ways.
	 */
	it.each([
		["ask", "Ask all"],
		["ask-command", "Ask cmds"],
		["auto", "Auto"],
		["yolo", "Yolo"],
	] as const)("renders %s as exactly its autonomy label with no mode active", (mode, label) => {
		expect(AUTONOMY_LABEL[mode]).toBe(label);

		const rendered = renderMode({ approvalMode: mode });

		expect(rendered.visible).toBe(true);
		expect(rendered.text).toBe(label);
	});

	/**
	 * An operator who never configured anything is on `auto`, because that is the
	 * schema default for `tools.approvalMode`. Rendering nothing here would leave
	 * the least-informed operator unable to see which rung is running their
	 * tools, which is the original bug.
	 */
	it("renders Auto when tools.approvalMode is unset, matching the schema default", () => {
		const rendered = renderMode({ unsetApprovalMode: true });

		expect(rendered.visible).toBe(true);
		expect(rendered.text).toBe("Auto");
	});
});

describe("the rung against states that outrank it", () => {
	/**
	 * The `/yolo` session bypass turns every prompt off regardless of the
	 * configured rung, so printing the rung beside it would name a rule that is
	 * not being enforced. The marker replaces it rather than joining it.
	 */
	it("replaces the rung with the YOLO marker while approvals are bypassed", () => {
		const rendered = renderMode({ approvalMode: "ask", bypassed: true });

		expect(rendered.visible).toBe(true);
		expect(rendered.text).toBe(`${theme.symbol("status.warning")} YOLO`);
		expect(rendered.text).not.toContain("Ask all");
	});

	/**
	 * Plan mode CAPS the rung to `plan`, so a session configured for `yolo` is
	 * running under plan rules. Rendering "Plan Yolo" told the operator the
	 * opposite of what the wrapper enforces, and "Plan Plan" was the other
	 * spelling of the same mistake.
	 */
	it("renders Plan alone in an active plan session, never the configured rung", () => {
		const rendered = renderMode({
			approvalMode: "yolo",
			planMode: { enabled: true, paused: false },
		});

		expect(rendered.visible).toBe(true);
		expect(rendered.text).toContain("Plan");
		expect(rendered.text).not.toContain("Yolo");
	});
});

describe("the mode label the segment already carried", () => {
	/**
	 * Adding the rung must not cost the segment its original job: the mode label
	 * comes first and the rung follows it, so both are readable at once.
	 *
	 * Asserted structurally rather than against a derived expected string. The
	 * derivation used to render the same context at the `plan` rung, because that
	 * suppressed the rung and left the mode label alone; `/permissions plan`
	 * proved that suppression wrong (with no plan session open the whole segment
	 * vanished) and the rung is named now, so there is no rung that renders a
	 * bare mode label to compare against.
	 */
	it.each([
		["vibe", { vibeMode: { enabled: true } }, "Vibe"],
		["loop", { loopMode: { enabled: true } }, "Loop"],
	] as const)("renders the %s label alongside the rung", (_name, mode, word) => {
		const rendered = renderMode({ ...mode, approvalMode: "auto" });

		expect(rendered.visible).toBe(true);
		expect(rendered.text).toContain(word);
		// The rung is last, and the mode label is not swallowed by it.
		expect(rendered.text.endsWith(` ${AUTONOMY_LABEL.auto}`)).toBe(true);
		expect(rendered.text.indexOf(word)).toBeLessThan(rendered.text.indexOf(AUTONOMY_LABEL.auto));
	});
});
