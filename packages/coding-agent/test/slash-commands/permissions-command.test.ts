/**
 * `/permissions` moves the autonomy rung for THIS SESSION and writes nothing to
 * disk.
 *
 * WHY THIS SUITE EXISTS. The rung has two homes with different lifetimes: a
 * saved default an operator picks once, and a session override for the task in
 * front of them. Collapsing those is the failure mode in both directions. If
 * `/permissions yolo` persisted, an operator who loosened the rung for one
 * risky refactor would launch tomorrow with prompts still off and no memory of
 * having asked for that. If `reset` wrote the default back instead of dropping
 * the override, a later change to the saved default would silently lose to a
 * stale copy. Every case below reads `Settings.getSource`, because "what is the
 * effective value" cannot tell those layers apart and the reported origin is
 * half of what the command exists to say.
 *
 * The suite also pins `/permissions yolo` apart from `/yolo`. They are two
 * different switches: one is the top rung of a ladder that still honours
 * `tools.approval` denials and the bash critical floor, the other is the
 * full-bypass session flag. Conflating them would be a safety bug, so this
 * asserts that reaching the rung never touches the bypass.
 */
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import { resolveEffectiveApprovalMode } from "@veyyon/coding-agent/tools/approval";

const USAGE = "Usage: /permissions [ask|ask-command|auto|yolo|plan|reset]";

interface Harness {
	/** Everything the command showed the operator, in order. */
	messages: string[];
	/** Calls to `session.setApprovalBypass`, which `/permissions` must never make. */
	bypassCalls: boolean[];
	runtime: { ctx: InteractiveModeContext };
}

/**
 * Things that outrank the stored rung and live on the session, not in settings.
 * Both default off, so an unparameterised harness is a plain session whose
 * enforced rung is whatever `tools.approvalMode` says.
 */
interface SessionOverrides {
	/** `--yolo` / `--auto-approve` was passed on the launch command line. */
	cliAutoApprove?: boolean;
	/** A plan session is open, capping the ladder to `plan`. */
	planModeActive?: boolean;
}

function createHarness(overrides: SessionOverrides = {}): Harness {
	const messages: string[] = [];
	const bypassCalls: boolean[] = [];
	let bypassed = false;

	const ctx = {
		session: {
			isApprovalBypassed: () => bypassed,
			setApprovalBypass: (value: boolean) => {
				bypassCalls.push(value);
				bypassed = value;
			},
			// The real `AgentSession.effectiveApprovalMode` resolves the enforced
			// rung by calling `resolveEffectiveApprovalMode` on the configured one.
			// Calling the same function here rather than restating the precedence
			// keeps the stub from claiming a rung production would not enforce.
			effectiveApprovalMode: () =>
				resolveEffectiveApprovalMode(settings.get("tools.approvalMode"), {
					planModeActive: overrides.planModeActive === true,
					cliAutoApprove: overrides.cliAutoApprove === true,
				}),
		},
		editor: { setText: () => {} },
		statusLine: { invalidate: () => {} },
		ui: { requestRender: () => {} },
		showStatus: (text: string) => {
			messages.push(text);
		},
		updateEditorBorderColor: () => {},
	} as unknown as InteractiveModeContext;

	return { messages, bypassCalls, runtime: { ctx } };
}

/** Run one `/permissions` invocation and return the single status line it showed. */
async function run(text: string, harness: Harness): Promise<string> {
	const handled = await executeBuiltinSlashCommand(text, harness.runtime);
	expect(handled).toBe(true);
	const message = harness.messages.at(-1);
	if (message === undefined) throw new Error(`/permissions showed no status for: ${text}`);
	return message;
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

beforeEach(() => {
	// Return the store to "operator has configured nothing" so each case starts
	// from the schema default rather than the previous case's rung.
	settings.clearOverride("tools.approvalMode");
	settings.unset("tools.approvalMode");
});

describe("setting the rung for this session", () => {
	/**
	 * The rung changes, and the message names both the rung and where it came
	 * from. "Ask cmds" alone leaves the operator unable to tell this from a saved
	 * preference, and the two need different actions to undo.
	 */
	it("applies ask-command as a runtime override and reports the session origin", async () => {
		const harness = createHarness();

		const message = await run("/permissions ask-command", harness);

		expect(settings.get("tools.approvalMode")).toBe("ask-command");
		expect(settings.getSource("tools.approvalMode")).toBe("runtime");
		expect(message).toContain("Ask cmds (session)");
	});

	/**
	 * THE PERSISTENCE CONTRACT. Dropping the runtime layer alone must restore the
	 * exact state the store was in beforehand. If the command had also written a
	 * saved value, `getSource` would still report a configured layer here and
	 * `isConfigured` would stay true, which is the bug: a one-session decision
	 * that outlives the session.
	 */
	it("changes only the runtime layer, leaving nothing configured underneath", async () => {
		const harness = createHarness();
		expect(settings.isConfigured("tools.approvalMode")).toBe(false);
		expect(settings.getSource("tools.approvalMode")).toBe("default");

		await run("/permissions yolo", harness);
		expect(settings.getSource("tools.approvalMode")).toBe("runtime");

		settings.clearOverride("tools.approvalMode");

		expect(settings.isConfigured("tools.approvalMode")).toBe(false);
		expect(settings.getSource("tools.approvalMode")).toBe("default");
	});
});

describe("dropping the session override", () => {
	/** With nothing saved, reset returns the operator to the schema default, `auto`. */
	it("reports the default origin when no value was ever configured", async () => {
		const harness = createHarness();
		await run("/permissions ask", harness);

		const message = await run("/permissions reset", harness);

		expect(settings.getSource("tools.approvalMode")).toBe("default");
		expect(message).toContain("Auto (default)");
	});

	/**
	 * With a saved value, reset drops the override and lets the SAVED value win
	 * again. Writing the default back instead would pin a stale copy in the
	 * runtime layer and make a later change to the saved value invisible.
	 */
	it("restores the saved value and reports the saved origin", async () => {
		settings.set("tools.approvalMode", "auto");
		const harness = createHarness();
		await run("/permissions yolo", harness);
		expect(settings.get("tools.approvalMode")).toBe("yolo");

		const message = await run("/permissions reset", harness);

		expect(settings.get("tools.approvalMode")).toBe("auto");
		expect(settings.getSource("tools.approvalMode")).toBe("profile");
		expect(message).toContain("Auto (saved)");
	});

	/** `default` is the same door as `reset`, so both words have to work. */
	it("accepts default as a synonym for reset", async () => {
		const harness = createHarness();
		await run("/permissions auto", harness);

		await run("/permissions default", harness);

		expect(settings.getSource("tools.approvalMode")).toBe("default");
	});
});

describe("invocations that must not change the rung", () => {
	/** Reading the state is not setting it. */
	it("reports without changing anything when given no argument", async () => {
		settings.set("tools.approvalMode", "ask-command");
		const harness = createHarness();

		const message = await run("/permissions", harness);

		expect(message).toContain("Ask cmds (saved)");
		expect(settings.get("tools.approvalMode")).toBe("ask-command");
		expect(settings.getSource("tools.approvalMode")).toBe("profile");
	});

	/**
	 * A typo must be inert. Falling through to `override` with an unvalidated
	 * word would put a string the ladder does not know into the runtime layer,
	 * where `normalizeApprovalMode` silently reads it as `ask` and the operator
	 * believes they are on the rung they typed.
	 */
	it("returns the usage string for an unrecognized word and leaves the rung alone", async () => {
		const harness = createHarness();
		await run("/permissions auto", harness);

		const message = await run("/permissions ask-everything", harness);

		expect(message).toBe(USAGE);
		expect(settings.get("tools.approvalMode")).toBe("auto");
		expect(settings.getSource("tools.approvalMode")).toBe("runtime");
	});
});

describe("the yolo rung against the yolo bypass", () => {
	/**
	 * `yolo` is a rung on the ladder and is reachable here. It is NOT the `/yolo`
	 * full bypass: that is a separate session flag with its own red editor
	 * border, and a command that quietly set it would hand out more rope than the
	 * operator asked for while every surface kept saying "rung".
	 */
	it("reaches the yolo rung without arming the session bypass", async () => {
		const harness = createHarness();

		const message = await run("/permissions yolo", harness);

		expect(settings.get("tools.approvalMode")).toBe("yolo");
		expect(message).toContain("Yolo (session)");
		expect(harness.bypassCalls).toEqual([]);
		expect(harness.runtime.ctx.session.isApprovalBypassed()).toBe(false);
	});

	/** And the reverse: the rung is left where it was by anything else. */
	it("leaves the rung untouched when the bypass is already on", async () => {
		const harness = createHarness();
		harness.runtime.ctx.session.setApprovalBypass(true);

		const message = await run("/permissions", harness);

		expect(settings.getSource("tools.approvalMode")).toBe("default");
		expect(message).toContain("Auto (default)");
	});
});

describe("reporting the rung the session will actually enforce", () => {
	/**
	 * THE BUG THIS BRANCH EXISTS FOR. `--yolo` forces the top rung for the whole
	 * run and is invisible in `tools.approvalMode`, so reading only the setting
	 * made `veyyon --yolo` plus `/permissions ask` answer "Ask all" about a
	 * session running every tool unasked. The enforced rung leads, and the stored
	 * one is still named so the operator can see what their `ask` is losing to.
	 */
	it("reports yolo and blames --yolo when the flag outranks a stored ask", async () => {
		const harness = createHarness({ cliAutoApprove: true });
		await run("/permissions ask", harness);

		const message = await run("/permissions", harness);

		expect(settings.get("tools.approvalMode")).toBe("ask");
		expect(message).toContain("Tool approval: Yolo (--yolo, overriding Ask all session)");
	});

	/**
	 * A plan session caps the ladder to `plan`, so a configured `yolo` cannot
	 * execute inside one. Reporting "Yolo" here would promise rope the wrapper
	 * will not hand out, which is the same misreport as the `--yolo` case in the
	 * opposite direction.
	 */
	it("reports plan and blames plan mode when a plan session caps a stored yolo", async () => {
		settings.set("tools.approvalMode", "yolo");
		const harness = createHarness({ planModeActive: true });

		const message = await run("/permissions", harness);

		expect(message).toContain("Tool approval: Plan (plan mode, overriding Yolo saved)");
		expect(message).not.toContain("Tool approval: Yolo");
	});

	/**
	 * With nothing outranking the stored value the sentence keeps its plain
	 * `<Label> (<origin>)` shape. The override clause is only correct when
	 * something really is overriding; firing it on every session would tell an
	 * operator their own `/permissions yolo` was imposed on them.
	 */
	it("keeps the plain label and origin when nothing outranks the stored rung", async () => {
		const harness = createHarness();

		const message = await run("/permissions yolo", harness);

		expect(message).toContain("Tool approval for this session: Yolo (session).");
		expect(message).not.toContain("overriding");
	});
});
