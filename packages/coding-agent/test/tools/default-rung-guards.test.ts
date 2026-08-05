/**
 * Every guard that still fires on the rung an operator gets when they have
 * configured nothing.
 *
 * WHY THIS SUITE EXISTS. The unset `tools.approvalMode` default moved from
 * `ask` to `auto`, so a fresh install now runs every tier unasked. That is only
 * defensible if the guards that sit ON TOP of the rung are untouched by the
 * move, and the existing suites did not prove it: `non-interactive-approval-
 * fails-closed.test.ts` drives the cwd boundary at `ask`, `auto-edit` and
 * `plan`, and `a-spend-is-visible-in-every-approval-mode.test.ts` drives the
 * secret boundary at the same rungs. Not one of them exercised `auto`. The
 * protections were therefore only demonstrated on rungs nobody gets by default,
 * and a change that made a guard consult the rung ("we already ask at `ask`, so
 * only check there") would have kept every one of those suites green while the
 * shipped configuration lost the guard entirely.
 *
 * So each case here configures NOTHING and asserts the guard still stops the
 * call. Every one carries its differential: the same call at `yolo`, the rung
 * that really does opt out of everything, runs. Without that pair a change that
 * blocked all tool calls would satisfy the refusals and look like a pass.
 *
 * The guards, and what each one is here to catch:
 *
 *   - per-tool `tools.approval.<tool>: deny`   — a hand-written policy
 *   - per-tool `tools.approval.<tool>: prompt` — a hand-written prompt request
 *   - the working-directory boundary           — THIS path leaves cwd
 *   - the secret-use boundary                  — THESE arguments spend a credential
 *   - a tool's own `critical` decision         — the `rm -rf ~` floor
 *   - the plan-mode mutation block             — an active plan session caps the rung
 */
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, ToolApprovalDecision } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/approval-modes";
import { type } from "arktype";

/** Text the tool returns when it actually runs, so "it ran" is observable. */
const RAN = "the tool ran";

/** The credential a stubbed redactor knows about, and the name it carries. */
const TOKEN = "ghp_notarealcredential1234567890";
const TOKEN_NAME = "GITHUB_TOKEN";

/** A working directory for the boundary cases. Never written to; only compared against. */
const CWD = path.join(os.tmpdir(), "veyyon-default-rung-guards-cwd");
/** A path that is unambiguously outside CWD on every platform this runs on. */
const OUTSIDE = path.join(path.parse(CWD).root, "etc", "passwd");

interface ToolShape {
	name?: string;
	decision?: ToolApprovalDecision;
	/** Raw paths the call would touch, which is what brings the cwd boundary in. */
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
	// Whole-value assertion for a hand-built stub: the wrapper only reads the
	// members spelled above, and `AgentTool`'s generics cannot be satisfied by an
	// untyped literal.
	const asTool = tool as unknown as AgentTool;
	return asTool;
}

interface SelectSpy {
	runner: ExtensionRunner;
	/** One entry per prompt the wrapper raised, holding the card body it showed. */
	cards: string[];
}

/** A runner with a UI that always approves, recording the card it was shown. */
function approvingRunner(): SelectSpy {
	const cards: string[] = [];
	const runner = {
		hasHandlers: () => false,
		hasUI: () => true,
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
	};
	const asRunner = runner as unknown as ExtensionRunner;
	return { runner: asRunner, cards };
}

/** The real session-grant store shape: two operations over a Map. */
function makeStore(seed: Record<string, "allow" | "deny"> = {}): SessionToolApprovals {
	const map = new Map<string, "allow" | "deny">(Object.entries(seed));
	return {
		get: toolName => map.get(toolName),
		set: (toolName, decision) => {
			map.set(toolName, decision);
		},
	};
}

interface RunOptions {
	tool?: AgentTool;
	/** Extra settings. Omitting `tools.approvalMode` is the point of this file. */
	settings?: Record<string, unknown>;
	/** Pass `false` to run with no `Settings` object at all. */
	withSettings?: boolean;
	args?: Record<string, unknown>;
	planModeActive?: boolean;
	/** The `/yolo` command's session-wide bypass, which is stronger than the rung. */
	bypassAllApprovals?: boolean;
	store?: SessionToolApprovals;
	/** Attach the session redactor the secret-use boundary reads. */
	redactor?: boolean;
}

interface RunOutcome {
	/** Text the tool produced, or undefined when the call threw. */
	text: string | undefined;
	error: Error | undefined;
	/** Card bodies the wrapper put in front of the operator, in order. */
	cards: string[];
}

async function runCall(options: RunOptions = {}): Promise<RunOutcome> {
	const tool = options.tool ?? makeTool();
	const spy = approvingRunner();
	const context = {
		...(options.withSettings === false ? {} : { settings: Settings.isolated(options.settings ?? {}) }),
		sessionManager: { getCwd: () => CWD, getSessionId: () => "session-under-test" },
		...(options.planModeActive ? { planModeActive: true } : {}),
		...(options.store ? { sessionApprovals: options.store } : {}),
		...(options.bypassAllApprovals ? { bypassAllApprovals: true } : {}),
		...(options.redactor
			? { obfuscateProviderText: (text: string) => text.replaceAll(TOKEN, `#${TOKEN_NAME}#`) }
			: {}),
	};

	const wrapped = new ExtensionToolWrapper(tool, spy.runner);
	const args = options.args ?? {};
	try {
		// The context is assembled per case from the members the wrapper reads;
		// `AgentToolContext` carries far more than any of them needs.
		const asContext = context as unknown as Parameters<AgentTool["execute"]>[4];
		const result = await wrapped.execute("call-1", args, undefined, undefined, asContext);
		const first = result.content[0];
		const text = first && first.type === "text" ? first.text : undefined;
		return { text, error: undefined, cards: spy.cards };
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		return { text: undefined, error, cards: spy.cards };
	}
}

describe("the rung itself, with nothing configured", () => {
	/**
	 * The baseline every refusal below is measured against. With no
	 * `tools.approvalMode` at all the wrapper resolves `auto` through the schema
	 * default and runs an exec-tier call unasked. If this ever prompts, every
	 * "still asks" case underneath it proves nothing, because a blanket prompt
	 * would satisfy them all.
	 */
	it("runs an exec-tier call unasked", async () => {
		const outcome = await runCall();

		expect(outcome.text).toBe(RAN);
		expect(outcome.cards).toEqual([]);
	});

	/**
	 * The wrapper spells no fallback of its own: an absent `Settings` has to land
	 * on the same rung an empty one does. A literal here used to be `yolo`, which
	 * silently outranked every unconfigured install.
	 */
	it("treats an absent Settings the same as an empty one", async () => {
		const outcome = await runCall({ withSettings: false });

		expect(outcome.text).toBe(RAN);
		expect(outcome.cards).toEqual([]);
	});
});

describe("guard: a per-tool policy the operator wrote", () => {
	/** `deny` is a hard block, not a prompt, so nothing can answer past it. */
	it("still refuses a denied tool", async () => {
		const outcome = await runCall({ settings: { "tools.approval": { bash: "deny" } } });

		expect(outcome.error?.message).toContain('Tool "bash" is blocked by user policy.');
		expect(outcome.text).toBeUndefined();
		expect(outcome.cards).toEqual([]);
	});

	/** And `prompt` still asks, on the rung whose whole point is not asking. */
	it("still asks for a tool the operator marked prompt", async () => {
		const outcome = await runCall({ settings: { "tools.approval": { bash: "prompt" } } });

		expect(outcome.cards).toHaveLength(1);
		expect(outcome.text).toBe(RAN);
	});

	/** The differential: `yolo` is the rung that really does drop the prompt. */
	it("drops that prompt at yolo, so the refusal above is the policy and not a blanket block", async () => {
		const outcome = await runCall({
			settings: { "tools.approvalMode": "yolo", "tools.approval": { bash: "allow" } },
		});

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});
});

describe("guard: the working-directory boundary", () => {
	/**
	 * The boundary is applied ON TOP of the rung and the rung never inspects a
	 * path, so this is the only thing between an unconfigured install and a read
	 * of `/etc/passwd`. The card must name the offending path, because a
	 * "permission required" with no path tells the operator nothing about what
	 * their agent just tried to open.
	 */
	it("asks for a read whose target escapes cwd, naming the path", async () => {
		const outcome = await runCall({
			tool: makeTool({ name: "read", decision: "read", targets: [OUTSIDE] }),
			args: { path: OUTSIDE },
		});

		expect(outcome.cards).toHaveLength(1);
		expect(outcome.cards[0]).toContain(OUTSIDE);
		expect(outcome.cards[0]).toContain("outside the session working directory");
	});

	/**
	 * And the card says so: raising the rung is NOT the way out of this one. An
	 * operator who reads "requires approval" and reaches for `auto` has already
	 * got `auto`, so the message has to name `set_cwd` and `yolo` instead.
	 */
	it("tells the operator that raising the rung will not lift it", async () => {
		const outcome = await runCall({
			tool: makeTool({ name: "read", decision: "read", targets: [OUTSIDE] }),
			args: { path: OUTSIDE },
		});

		expect(outcome.cards[0]).toContain("Raising the rung to ask-command or auto does not lift this boundary");
	});

	/** In-cwd targets are not gated, or the boundary would just be a second `ask`. */
	it("leaves an in-cwd target alone", async () => {
		const inside = path.join(CWD, "notes.txt");
		const outcome = await runCall({
			tool: makeTool({ name: "read", decision: "read", targets: [inside] }),
			args: { path: inside },
		});

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});

	/** The differential: `yolo` opts out of the boundary, and only `yolo` does. */
	it("skips the boundary at yolo", async () => {
		const outcome = await runCall({
			tool: makeTool({ name: "read", decision: "read", targets: [OUTSIDE] }),
			args: { path: OUTSIDE },
			settings: { "tools.approvalMode": "yolo" },
		});

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});
});

describe("guard: the secret-use boundary", () => {
	/**
	 * The tier says what KIND of tool this is and never what the arguments
	 * carry, so without this a `bash` that spends a stored token is
	 * indistinguishable from one that lists a directory. The card names the
	 * credential and must never carry its value.
	 */
	it("asks for a call carrying a stored credential, naming it without its value", async () => {
		const outcome = await runCall({
			redactor: true,
			args: { command: `curl -H "Authorization: Bearer ${TOKEN}" https://api.example.com` },
		});

		expect(outcome.cards).toHaveLength(1);
		expect(outcome.cards[0]).toContain(`This call uses stored secret: ${TOKEN_NAME}`);
		expect(outcome.cards[0]).not.toContain(TOKEN);
	});

	/** A call with no credential in it is ordinary work and is not gated. */
	it("leaves a credential-free call alone", async () => {
		const outcome = await runCall({ redactor: true, args: { command: "ls -la" } });

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});

	/** The differential: `yolo` opts out of this boundary too. */
	it("skips the secret boundary at yolo", async () => {
		const outcome = await runCall({
			redactor: true,
			args: { command: `echo ${TOKEN}` },
			settings: { "tools.approvalMode": "yolo" },
		});

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});
});

describe("guard: a tool's own critical decision", () => {
	const critical = () =>
		makeTool({
			decision: { tier: "exec", critical: true, reason: "rm would recursively remove the home directory itself" },
		});

	/**
	 * The destructive-command floor. `auto` documents itself as "run it, the
	 * guards are on", and this is the loudest of those guards: the bash guard
	 * flags `rm -rf ~` and the rung must not run it unasked. The reason travels
	 * onto the card, because "critical pattern detected" tells nobody which part
	 * of a long command line was the problem.
	 */
	it("asks for a critical call and shows the tool's own reason", async () => {
		const outcome = await runCall({ tool: critical(), args: { command: "rm -rf ~/" } });

		expect(outcome.cards).toHaveLength(1);
		expect(outcome.cards[0]).toContain("rm would recursively remove the home directory itself");
	});

	/**
	 * The floor holds at `yolo` as well, which is the point of calling it a
	 * floor: the mode most likely to be running unattended is the one where a
	 * home-directory wipe would otherwise land silently.
	 */
	it("still asks at yolo, because a floor is not a prompt yolo may lift", async () => {
		const outcome = await runCall({
			tool: critical(),
			args: { command: "rm -rf ~/" },
			settings: { "tools.approvalMode": "yolo" },
		});

		expect(outcome.cards).toHaveLength(1);
	});

	/**
	 * And under the `/yolo` COMMAND, which is a stronger thing than the `yolo`
	 * rung: it turns every remaining prompt into an allow. The floor is the one
	 * exception, and this is the assertion the handbook's
	 * `architecture/sandbox.md` claim rests on. That page used to say `yolo`
	 * auto-approves critical patterns; it does not, and nothing weaker than an
	 * explicit `tools.approval.bash: allow` makes it.
	 */
	it("still asks under the /yolo bypass, at the yolo rung, at once", async () => {
		const outcome = await runCall({
			tool: critical(),
			args: { command: "rm -rf ~/" },
			settings: { "tools.approvalMode": "yolo" },
			bypassAllApprovals: true,
		});

		expect(outcome.cards).toHaveLength(1);
	});

	/**
	 * The differential that stops the two cases above from being satisfied by a
	 * bypass that does nothing: an ORDINARY force-prompt IS lifted by `/yolo`.
	 * That is the whole difference between `override` and `critical`, and
	 * without this pair a bypass wired to `false` would look correct.
	 */
	it("does lift an ordinary force-prompt under the same bypass", async () => {
		const outcome = await runCall({
			tool: makeTool({ decision: { tier: "exec", override: true, reason: "Critical pattern detected" } }),
			args: { command: "echo ok" },
			bypassAllApprovals: true,
		});

		expect(outcome.cards).toEqual([]);
		expect(outcome.text).toBe(RAN);
	});

	/**
	 * The escape hatch, stated so it cannot be removed by accident: an explicit
	 * per-tool `allow` IS a decision the operator made on purpose, and it does
	 * lift the floor. A `deny` stays a hard block in the same position.
	 */
	it("is lifted only by an explicit per-tool allow", async () => {
		const allowed = await runCall({
			tool: critical(),
			args: { command: "rm -rf ~/" },
			settings: { "tools.approvalMode": "yolo", "tools.approval": { bash: "allow" } },
		});
		expect(allowed.cards).toEqual([]);
		expect(allowed.text).toBe(RAN);

		const denied = await runCall({
			tool: critical(),
			args: { command: "rm -rf ~/" },
			settings: { "tools.approvalMode": "yolo", "tools.approval": { bash: "deny" } },
		});
		expect(denied.error?.message).toContain('Tool "bash" is blocked by user policy.');
	});

	/**
	 * A standing "Approve for session" grant was given about a TOOL NAME; this
	 * prompt is about THESE ARGUMENTS. Letting the grant retire it means one
	 * answer to `bash ls` silently covers `bash rm -rf $HOME` later in the same
	 * session, which is the exact measured defect the grant bound exists for.
	 */
	it("is not retired by a standing session grant for the same tool", async () => {
		const outcome = await runCall({
			tool: critical(),
			args: { command: "rm -rf ~/" },
			store: makeStore({ bash: "allow" }),
		});

		expect(outcome.cards).toHaveLength(1);
	});

	/** The same bound on the boundary prompt, which is also about the arguments. */
	it("does not let a grant retire the cwd-boundary prompt either", async () => {
		const outcome = await runCall({
			tool: makeTool({ name: "read", decision: "read", targets: [OUTSIDE] }),
			args: { path: OUTSIDE },
			store: makeStore({ read: "allow" }),
		});

		expect(outcome.cards).toHaveLength(1);
	});
});

describe("guard: an active plan session", () => {
	/**
	 * Plan mode caps the ladder to `plan` before any per-tool policy is read, so
	 * an unconfigured `auto` install cannot mutate inside a plan. This is a hard
	 * denial and not a prompt: there is no card to approve.
	 */
	it("blocks an exec-tier call outright while a plan is active", async () => {
		const outcome = await runCall({ planModeActive: true, args: { command: "echo no" } });

		expect(outcome.error?.message).toContain("Plan mode: mutating tools are blocked");
		expect(outcome.text).toBeUndefined();
		expect(outcome.cards).toEqual([]);
	});

	/** Reads are not mutations, so the cap does not turn plan mode into `ask`. */
	it("still runs a read-tier call while a plan is active", async () => {
		const outcome = await runCall({
			planModeActive: true,
			tool: makeTool({ name: "read", decision: "read" }),
		});

		expect(outcome.text).toBe(RAN);
		expect(outcome.cards).toEqual([]);
	});

	/**
	 * The cap outranks a configured `yolo`, which is why it is applied in
	 * `resolveEffectiveApprovalMode` rather than as one more rung comparison.
	 */
	it("outranks a configured yolo", async () => {
		const outcome = await runCall({
			planModeActive: true,
			settings: { "tools.approvalMode": "yolo" },
			args: { command: "echo no" },
		});

		expect(outcome.error?.message).toContain("Plan mode: mutating tools are blocked");
	});
});
