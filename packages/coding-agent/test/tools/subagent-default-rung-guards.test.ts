/**
 * THE BUG THIS LOCKS OUT.
 *
 * The unset `tools.approvalMode` default moved from `ask` to `auto`, and
 * `default-rung-guards.test.ts` proves the guards that sit on top of the rung survive
 * that move. Every case in that file drives the MAIN session. Not one of them drives a
 * SPAWNED agent, and a spawned agent does not run on the operator's rung: it runs on
 * whatever `createSubagentSettings` writes into its runtime override layer.
 *
 * That distinction is not academic. The wrapper opts a call out of the working-directory
 * boundary and the secret-use boundary on exactly one condition, `approvalMode === "yolo"`,
 * and `createSubagentSettings` sets `"tools.approvalMode": "yolo"` unconditionally for
 * every spawned agent. So a `read` of `/etc/passwd` and a `bash` that spends a stored
 * credential are ungated for a subagent, on a default install, with the operator having
 * configured nothing. A guard that holds only on the main session is the worst version
 * of the default change, because the operator sees the main-session guard fire, believes
 * the boundary exists, and delegates the same work to a subagent that has no boundary.
 *
 * WHY IT IS WRITTEN AGAINST THE REAL SETTINGS BUILDER. The rung a subagent gets is
 * decided by `createSubagentSettings`, so a test that hand-writes a mode string is
 * testing its own literal. These cases fork the real builder from a bare parent
 * `Settings` (nothing configured, exactly like a fresh install) and hand the RESULT to
 * the same `ExtensionToolWrapper` production uses, so changing the override in
 * `task/executor.ts` moves these assertions.
 *
 * IF IT REGRESSES: `task` becomes a laundering path around every boundary the main
 * session enforces. Anything the operator would have been asked about, the agent gets by
 * delegating it one level down.
 */
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, ToolApprovalDecision } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { createSubagentSettings } from "@veyyon/coding-agent/task/executor";
import { type } from "arktype";

/** Text the tool returns when it actually runs, so "it ran" is observable. */
const RAN = "the tool ran";

const TOKEN = "ghp_notarealcredential1234567890";
const TOKEN_NAME = "GITHUB_TOKEN";

const CWD = path.join(os.tmpdir(), "veyyon-subagent-rung-guards-cwd");
/** Unambiguously outside CWD on every platform this runs on. */
const OUTSIDE = path.join(path.parse(CWD).root, "etc", "passwd");

interface ToolShape {
	name?: string;
	decision?: ToolApprovalDecision;
	targets?: string[];
}

function makeTool({ name = "bash", decision = "exec", targets }: ToolShape = {}): AgentTool {
	const tool = {
		name,
		label: name,
		summary: "records that it ran",
		description: "records that it ran",
		parameters: type({}),
		approval: () => decision,
		execute: async () => ({ content: [{ type: "text", text: RAN }] }),
		...(targets ? { filesystemTargets: () => targets } : {}),
	};
	return tool as unknown as AgentTool;
}

interface RunOutcome {
	text: string | undefined;
	error: Error | undefined;
	/** Card bodies the wrapper put in front of the approver, in order. */
	cards: string[];
}

interface RunOptions {
	tool?: AgentTool;
	args?: Record<string, unknown>;
	/** Attach the session redactor the secret-use boundary reads. */
	redactor?: boolean;
	/**
	 * Extra parent-level settings, applied BEFORE the subagent fork, so a case can
	 * show what an operator who configured something explicitly actually gets.
	 */
	parentSettings?: Record<string, unknown>;
	/** Drive the parent's own settings instead of the subagent fork, for the differential. */
	asMainSession?: boolean;
	/**
	 * Drop the approval surface entirely, reproducing what a spawned agent has TODAY:
	 * `task/executor.ts` calls `extensionRunner.initialize(actions, runtime)` with no
	 * fourth `uiContext` argument, so the child's runner keeps `noOpUIContext` and
	 * `hasUI()` is false. This is the condition that makes the request unanswerable.
	 */
	withoutApprovalSurface?: boolean;
}

/**
 * Runs one call through the wrapper, on the settings a SPAWNED agent gets.
 *
 * A UI that always approves is attached deliberately: a subagent is headless, but the
 * question here is whether the guard produces a decision point at all. Recording the
 * card is how "the guard fired" becomes observable rather than inferred, and a headless
 * runner would collapse "no guard" and "guard, then auto-denied" into the same result.
 */
async function runSubagentCall(options: RunOptions = {}): Promise<RunOutcome> {
	const parent = Settings.isolated(options.parentSettings ?? {});
	const settings = options.asMainSession === true ? parent : createSubagentSettings(parent);
	const cards: string[] = [];
	const runner = {
		hasHandlers: () => false,
		hasUI: () => options.withoutApprovalSurface !== true,
		getUIContext: () => ({
			select: async (body: string) => {
				cards.push(body);
				return "Approve";
			},
		}),
		emit: async () => undefined,
		emitToolCall: async () => undefined,
		emitToolResult: async () => undefined,
		createContext: () => ({}),
	} as unknown as ExtensionRunner;

	const context = {
		settings,
		sessionManager: { getCwd: () => CWD, getSessionId: () => "subagent-under-test" },
		...(options.redactor
			? { obfuscateProviderText: (text: string) => text.replaceAll(TOKEN, `#${TOKEN_NAME}#`) }
			: {}),
	};

	const wrapped = new ExtensionToolWrapper(options.tool ?? makeTool(), runner);
	try {
		const asContext = context as unknown as Parameters<AgentTool["execute"]>[4];
		const result = await wrapped.execute("call-1", options.args ?? {}, undefined, undefined, asContext);
		const first = result.content[0];
		return { text: first && first.type === "text" ? first.text : undefined, error: undefined, cards };
	} catch (err) {
		return { text: undefined, error: err instanceof Error ? err : new Error(String(err)), cards };
	}
}

describe("a spawned agent inherits the spawning session's rung", () => {
	/**
	 * THE RULING THIS PINS: subagents inherit the parent's permissions. Stated as an
	 * EQUALITY across every rung, not as "the child is not yolo", because the defect was
	 * not the specific literal `"yolo"`, it was `createSubagentSettings` writing ANY
	 * literal at all. A hardcoded `"auto"` would satisfy a negative assertion and still
	 * override an operator who chose `ask`.
	 *
	 * Reported as one string per rung so a failure names which rung was rewritten and
	 * what it became, rather than only that some rung was wrong.
	 */
	it("resolves to exactly the parent's rung, for every rung", () => {
		for (const configured of ["plan", "ask", "ask-command", "auto-edit", "auto", "yolo"]) {
			const parent = Settings.isolated({ "tools.approvalMode": configured });
			const child = createSubagentSettings(parent);
			expect(`${configured} -> ${child.get("tools.approvalMode")}`).toBe(`${configured} -> ${configured}`);
		}
	});

	/**
	 * And an UNSET parent inherits the unset default rather than a spawn-only literal.
	 * This is the fresh-install case, the configuration nearly every operator is on, and
	 * the one the hardcode did the most damage to.
	 */
	it("inherits the unset default when the operator configured nothing", () => {
		const parent = Settings.isolated({});
		expect(parent.get("tools.approvalMode")).toBe("auto");
		expect(createSubagentSettings(parent).get("tools.approvalMode")).toBe("auto");
	});

	/**
	 * A nested spawn inherits too. Inheritance that holds one level down and resets at
	 * two is a laundering path with one extra hop, so the grandchild is asserted from the
	 * same parent value rather than assumed to follow.
	 */
	it("keeps the rung across a nested spawn", () => {
		const parent = Settings.isolated({ "tools.approvalMode": "ask" });
		const grandchild = createSubagentSettings(createSubagentSettings(parent));
		expect(grandchild.get("tools.approvalMode")).toBe("ask");
	});

	/**
	 * The other overrides in the same fork are genuine runtime policy and must survive,
	 * or a fix that dropped the whole override block would pass every case above while
	 * quietly re-enabling async jobs and bash auto-backgrounding inside subagents.
	 */
	it("still applies the headless runtime policies it does own", () => {
		const child = createSubagentSettings(Settings.isolated({ "tools.approvalMode": "ask" }));
		expect(child.get("async.enabled")).toBe(false);
		expect(child.get("bash.autoBackground.enabled")).toBe(false);
	});
});

describe("guard: the working-directory boundary holds for a spawned agent", () => {
	/**
	 * The headline. `read /etc/passwd` from a subagent, default install, nothing
	 * configured. The main-session suite proves this is gated; the boundary is skipped
	 * whenever the resolved rung is `yolo`, and a subagent's rung is set by a single
	 * literal in `task/executor.ts`.
	 */
	it("gates a read whose target escapes cwd, naming the path", async () => {
		const outcome = await runSubagentCall({
			tool: makeTool({ name: "read", decision: "read", targets: [OUTSIDE] }),
			args: { path: OUTSIDE },
		});

		expect(outcome.cards).toHaveLength(1);
		expect(outcome.cards[0]).toContain(OUTSIDE);
		expect(outcome.cards[0]).toContain("outside the session working directory");
	});

	/**
	 * The differential. Without it, a change that gated every subagent call would
	 * satisfy the case above and look like a pass. An in-cwd target is ordinary
	 * delegated work and must stay ungated, or `task` becomes unusable.
	 */
	it("leaves an in-cwd target alone", async () => {
		const inside = path.join(CWD, "notes.txt");
		const outcome = await runSubagentCall({
			tool: makeTool({ name: "read", decision: "read", targets: [inside] }),
			args: { path: inside },
		});

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});

	/**
	 * The parity assertion, which is the actual contract: the guard behaves the SAME on
	 * both sides of a spawn. Stated as one comparison so a failure reports which side
	 * lost the boundary rather than only that one side failed.
	 */
	it("gates the escaping read identically on the main session and in a spawn", async () => {
		const tool = () => makeTool({ name: "read", decision: "read", targets: [OUTSIDE] });
		const main = await runSubagentCall({ tool: tool(), args: { path: OUTSIDE }, asMainSession: true });
		const spawned = await runSubagentCall({ tool: tool(), args: { path: OUTSIDE } });

		expect(`spawned gated: ${spawned.cards.length}`).toBe(
			`main gated: ${main.cards.length}`.replace("main", "spawned"),
		);
	});
});

describe("guard: the secret-use boundary holds for a spawned agent", () => {
	/**
	 * A subagent spending the operator's stored credential is the case that matters
	 * most here: delegation is how an agent reaches for a token without the operator
	 * watching the arguments. The card must name the credential and never carry its
	 * value, in a spawn exactly as on the main session.
	 */
	it("gates a call carrying a stored credential, naming it without its value", async () => {
		const outcome = await runSubagentCall({
			redactor: true,
			args: { command: `curl -H "Authorization: Bearer ${TOKEN}" https://api.example.com` },
		});

		expect(outcome.cards).toHaveLength(1);
		expect(outcome.cards[0]).toContain(`This call uses stored secret: ${TOKEN_NAME}`);
		expect(outcome.cards[0]).not.toContain(TOKEN);
	});

	/** The differential: a credential-free call from a subagent is ordinary work. */
	it("leaves a credential-free call alone", async () => {
		const outcome = await runSubagentCall({ redactor: true, args: { command: "ls -la" } });

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});

	/** Parity with the main session, reported as one comparison. */
	it("gates the credential-spending call identically on the main session and in a spawn", async () => {
		const args = { command: `echo ${TOKEN}` };
		const main = await runSubagentCall({ redactor: true, args, asMainSession: true });
		const spawned = await runSubagentCall({ redactor: true, args });

		expect(`gated: ${spawned.cards.length}`).toBe(`gated: ${main.cards.length}`);
	});
});

describe("guard: a tool's own critical decision holds for a spawned agent", () => {
	const critical = () =>
		makeTool({
			decision: { tier: "exec", critical: true, reason: "rm would recursively remove the home directory itself" },
		});

	/**
	 * The destructive-command floor, `rm -rf ~`. This is the one guard an operator would
	 * never expect a spawn to opt out of, and the reason must travel onto the card:
	 * "critical pattern detected" tells nobody which part of the command was the problem.
	 */
	it("gates a critical call and carries the tool's reason", async () => {
		const outcome = await runSubagentCall({ tool: critical(), args: { command: "rm -rf ~" } });

		expect(outcome.cards).toHaveLength(1);
		expect(outcome.cards[0]).toContain("rm would recursively remove the home directory itself");
	});

	/** The differential: a non-critical exec call from a subagent still runs unasked. */
	it("leaves a non-critical exec call alone", async () => {
		const outcome = await runSubagentCall({ args: { command: "ls -la" } });

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});

	/** Parity with the main session, reported as one comparison. */
	it("gates the critical call identically on the main session and in a spawn", async () => {
		const args = { command: "rm -rf ~" };
		const main = await runSubagentCall({ tool: critical(), args, asMainSession: true });
		const spawned = await runSubagentCall({ tool: critical(), args });

		expect(`gated: ${spawned.cards.length}`).toBe(`gated: ${main.cards.length}`);
	});
});

describe("guard: a per-tool policy the operator wrote holds for a spawned agent", () => {
	/**
	 * `deny` is a hard block, not a prompt, so nothing can answer past it. The subagent
	 * override comment claims "user `tools.approval` policies still apply"; this is the
	 * assertion that turns that claim into a contract.
	 */
	it("still refuses a tool the operator denied", async () => {
		const outcome = await runSubagentCall({ parentSettings: { "tools.approval": { bash: "deny" } } });

		expect(outcome.error?.message).toContain('Tool "bash" is blocked by user policy.');
		expect(outcome.text).toBeUndefined();
	});

	/**
	 * And a policy the operator did NOT write does not block, or the case above would
	 * pass against a subagent that refuses everything.
	 */
	it("runs a tool with no policy against it", async () => {
		const outcome = await runSubagentCall({ parentSettings: { "tools.approval": { read: "deny" } } });

		expect(outcome.text).toBe(RAN);
	});
});

describe("a spawned agent's approval request is never silently dropped", () => {
	/**
	 * THE SECOND HALF OF THE RULING: a subagent's permission request must be SURFACED,
	 * never swallowed. This is the assertion that separates a real fix from the hardcode
	 * that was there before, because the hardcode made the question go away rather than
	 * answering it, and every functional assertion in the repo stayed green while it did.
	 *
	 * At an inherited `ask` rung a spawned agent's ordinary exec call must PRODUCE a
	 * request. Zero requests is the defect, in either of its two spellings: a rung that
	 * short-circuits the check (yesterday's `"yolo"`), or a request raised and then
	 * auto-resolved on the child's behalf.
	 */
	it("raises a request for an exec call at an inherited ask rung", async () => {
		const outcome = await runSubagentCall({ parentSettings: { "tools.approvalMode": "ask" } });

		expect(outcome.cards).toHaveLength(1);
		// The request names the tool, so whoever answers it knows what they are answering.
		expect(outcome.cards[0]).toContain("bash");
	});

	/**
	 * And the request count MATCHES the parent's for the same call, which is what
	 * "inherits the parent's permissions" means operationally. A child that raises fewer
	 * requests than its parent would for identical work has a boundary its parent does
	 * not, and that is the laundering path.
	 */
	it("raises the same number of requests the parent would for the same call", async () => {
		for (const rung of ["ask", "ask-command", "auto"]) {
			const parentSettings = { "tools.approvalMode": rung };
			const main = await runSubagentCall({ parentSettings, asMainSession: true });
			const spawned = await runSubagentCall({ parentSettings });
			expect(`${rung}: ${spawned.cards.length}`).toBe(`${rung}: ${main.cards.length}`);
		}
	});

	/**
	 * The differential that makes the case above mean something: at an inherited `yolo`
	 * the child raises nothing, because the operator chose that. Without this, a change
	 * that gated every subagent call unconditionally would satisfy both cases above.
	 */
	it("raises nothing at an inherited yolo rung, because the operator chose it", async () => {
		const outcome = await runSubagentCall({ parentSettings: { "tools.approvalMode": "yolo" } });

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});

	/**
	 * A request that nothing can answer must FAIL the call, not pass it.
	 *
	 * This is the deadlock the old hardcode was working around, pinned as the current
	 * honest behavior rather than hidden: with no approval surface the child refuses and
	 * says why. Routing the request to the parent's session is the fix for the deadlock,
	 * and when it lands this case changes to assert the parent received it. What must
	 * NEVER be true is the third option: the call proceeding as though it had been
	 * approved. That is the byte this assertion owns.
	 */
	it("refuses rather than proceeds when no surface can answer the request", async () => {
		const outcome = await runSubagentCall({
			parentSettings: { "tools.approvalMode": "ask" },
			withoutApprovalSurface: true,
		});

		expect(outcome.text).toBeUndefined();
		expect(outcome.error?.message).toContain("requires approval but no interactive UI available");
	});
});
