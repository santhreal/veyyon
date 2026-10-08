/**
 * "for this session" at an approval prompt remembers exactly one call's answer
 * for the rest of the session, and nothing more.
 *
 * WHY THIS SUITE EXISTS. The `ask` and `ask-command` rungs are only usable
 * because the dialog can remember. A run that touches twenty files asks twenty
 * times without it, and an operator answering twenty identical prompts turns
 * approvals off entirely, so a dialog with no memory is the same yolo reached
 * by a worse road. That makes the memory load-bearing in two directions at
 * once, and both directions are silent when they break:
 *
 *  - A remembered ALLOW that still prompts is merely annoying.
 *  - A plain "Approve" that is remembered anyway is a standing grant the
 *    operator never gave, and nothing on screen says so.
 *  - A renamed select label turns every "Approve for session" into a denial,
 *    because the wrapper matches the returned label by exact string.
 *  - A session grant that outranks `tools.approval.<tool>: deny` lets a dialog
 *    overwrite a policy the operator wrote by hand.
 *  - A grant that retires, or is recorded at, a card raised about one call's
 *    arguments (a critical command, a path outside the working directory, a
 *    stored credential) authorises a later call nobody was asked about.
 *
 * None of these show up in a type error, so they are pinned here in bytes.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { APPROVAL_SELECT_OPTIONS, ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/core/approval-modes";
import { type } from "arktype";

/** Text the tool returns when it actually runs, so "did it run" is observable. */
const RAN = "the tool ran";

/**
 * An exec-tier tool, which the `ask` rung always prompts for. Exec is used
 * rather than read so the prompt does not depend on which rung the case picked.
 */
function execTool(name = "bash"): AgentTool {
	return {
		name,
		label: name,
		summary: "records that it ran",
		description: "records that it ran",
		parameters: type({}),
		approval: () => ({ tier: "exec" as const }),
		execute: async () => ({ content: [{ type: "text", text: RAN }] }),
	} as unknown as AgentTool;
}

/** A credential the session's redactor knows, so a call carrying it spends a stored secret. */
const TOKEN = "ghp_sessiongrantcredential1234567890";

/** The session working directory the cwd boundary measures against. */
const CWD = "/repo-under-test";

/** Context fields that arm the cwd boundary and the secret-use boundary. */
const BOUNDARY_CONTEXT = {
	sessionManager: { getCwd: () => CWD, getSessionId: () => "session-under-test" },
	obfuscateProviderText: (text: string) => text.replaceAll(TOKEN, "#DEPLOY_TOKEN#"),
};

/**
 * Arguments that each raise the prompt about THIS call rather than about the
 * tool name: the three argument-scoped reasons the approval gate resolves. A
 * fourth such reason in `resolveApprovalGate` needs a row here; nothing makes
 * this table fail on its own when one is added.
 */
const ARGUMENT_SCOPED: Record<string, Record<string, unknown>> = {
	"a command the bash guard judges critical": { danger: true },
	"a path outside the working directory": { target: "/elsewhere/notes.txt" },
	"a stored credential in the arguments": { content: `token=${TOKEN}` },
};

/**
 * An exec-tier `bash` that can raise each argument-scoped prompt: `danger`
 * marks the call critical, `target` is a filesystem path the cwd boundary
 * measures, and any string argument is read by the secret-use boundary.
 */
function argumentScopedTool(): AgentTool {
	return {
		name: "bash",
		label: "bash",
		summary: "records that it ran",
		description: "records that it ran",
		parameters: type({ "danger?": "boolean", "target?": "string", "content?": "string" }),
		approval: (args: { danger?: boolean }) => ({ tier: "exec" as const, critical: args?.danger === true }),
		filesystemTargets: (args: { target?: string }) => (typeof args?.target === "string" ? [args.target] : []),
		execute: async () => ({ content: [{ type: "text", text: RAN }] }),
	} as unknown as AgentTool;
}

interface SelectSpy {
	runner: ExtensionRunner;
	/** Labels the wrapper handed to the UI, one entry per prompt shown. */
	calls: string[][];
}

/**
 * A runner whose only capability is an interactive select, recording every
 * invocation. The count is the evidence: "did not prompt" is not observable
 * from the call's return value alone.
 */
function runnerAnswering(choice: string | undefined): SelectSpy {
	const calls: string[][] = [];
	const runner = {
		hasHandlers: () => false,
		hasUI: () => true,
		getUIContext: () => ({
			select: async (_body: string, items: { label: string }[]) => {
				calls.push(items.map(item => item.label));
				return choice;
			},
		}),
		emit: async () => undefined,
		emitToolCall: async () => undefined,
		emitToolResult: async () => undefined,
		createContext: () => ({}),
	} as unknown as ExtensionRunner;
	return { runner, calls };
}

/** The real store shape: two operations over a Map, no iteration, no clear. */
function makeStore(seed: Record<string, "allow" | "deny"> = {}): SessionToolApprovals {
	const map = new Map<string, "allow" | "deny">(Object.entries(seed));
	return {
		get: (toolName: string) => map.get(toolName),
		set: (toolName: string, decision: "allow" | "deny") => {
			map.set(toolName, decision);
		},
	};
}

interface RunOptions {
	tool?: AgentTool;
	choice?: string | undefined;
	store?: SessionToolApprovals;
	/** `tools.approval.<tool>` policies, as they come out of settings. */
	policies?: Record<string, unknown>;
	/** The call's arguments; `{}` when omitted. */
	params?: Record<string, unknown>;
	/** Extra tool-context fields, for the cwd and secret-use boundaries. */
	context?: Record<string, unknown>;
}

interface RunOutcome {
	/** Text the tool produced, or undefined when the call threw. */
	text: string | undefined;
	error: Error | undefined;
	selectCalls: string[][];
	store: SessionToolApprovals;
}

async function runCall(options: RunOptions = {}): Promise<RunOutcome> {
	const tool = options.tool ?? execTool();
	const store = options.store ?? makeStore();
	const spy = runnerAnswering(options.choice);
	const context = {
		...options.context,
		settings: {
			get: (path: string) => {
				if (path === "tools.approvalMode") return "ask";
				if (path === "tools.approval") return options.policies ?? {};
				return undefined;
			},
		},
		sessionApprovals: store,
	};

	const wrapped = new ExtensionToolWrapper(tool, spy.runner);
	try {
		const result = await wrapped.execute(
			"call-1",
			(options.params ?? {}) as never,
			undefined,
			undefined,
			context as never,
		);
		const first = result.content[0];
		const text = first && first.type === "text" ? first.text : undefined;
		return { text, error: undefined, selectCalls: spy.calls, store };
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		return { text: undefined, error, selectCalls: spy.calls, store };
	}
}

describe("the labels offered at an approval prompt", () => {
	/**
	 * THE CONTRACT THAT LOOKS LIKE COSMETICS. The wrapper compares the returned
	 * label to these exact strings, so renaming "Approve for session" to
	 * "Always approve" makes every use of that row fall through to `approved ===
	 * false` and deny the call. Order is part of it too: the two approve rows are
	 * adjacent so the destructive row is never the one under the cursor.
	 */
	it("offers exactly the four rows, in order", () => {
		expect(APPROVAL_SELECT_OPTIONS.map(option => option.label)).toEqual([
			"Approve",
			"Approve for session",
			"Deny",
			"Deny for session",
		]);
	});

	/** The wrapper hands that same list to the UI, unmodified. */
	it("presents those rows at the prompt", async () => {
		const outcome = await runCall({ choice: "Approve" });

		expect(outcome.selectCalls).toEqual([["Approve", "Approve for session", "Deny", "Deny for session"]]);
	});
});

describe("a standing answer already in the session store", () => {
	/**
	 * A remembered allow must skip the dialog entirely. Asserting only that the
	 * call succeeded would pass with the prompt still firing, which is the whole
	 * behaviour the feature exists to remove, so the select count is the proof.
	 */
	it("runs the call without prompting when the store holds allow", async () => {
		const outcome = await runCall({ store: makeStore({ bash: "allow" }) });

		expect(outcome.error).toBeUndefined();
		expect(outcome.text).toBe(RAN);
		expect(outcome.selectCalls).toEqual([]);
	});

	/** A remembered deny refuses on its own terms and never re-asks. */
	it("throws the session-denial error without prompting when the store holds deny", async () => {
		const outcome = await runCall({ store: makeStore({ bash: "deny" }) });

		expect(outcome.error?.message).toBe("Tool call denied for this session: bash");
		expect(outcome.text).toBeUndefined();
		expect(outcome.selectCalls).toEqual([]);
	});

	/** A grant is per tool, not per session, so a different tool still asks. */
	it("does not let a grant for one tool cover another", async () => {
		const outcome = await runCall({
			tool: execTool("eval"),
			store: makeStore({ bash: "allow" }),
			choice: "Deny",
		});

		expect(outcome.selectCalls).toHaveLength(1);
		expect(outcome.error?.message).toBe("Tool call denied by user: eval");
	});
});

describe("what each row writes to the session store", () => {
	/** The remembering approve row runs the call and records the allow. */
	it("writes allow and runs the call for Approve for session", async () => {
		const outcome = await runCall({ choice: "Approve for session" });

		expect(outcome.text).toBe(RAN);
		expect(outcome.store.get("bash")).toBe("allow");
	});

	/** The remembering deny row refuses the call and records the deny. */
	it("writes deny and refuses the call for Deny for session", async () => {
		const outcome = await runCall({ choice: "Deny for session" });

		expect(outcome.error?.message).toBe("Tool call denied by user: bash");
		expect(outcome.store.get("bash")).toBe("deny");
	});

	/**
	 * THE CASE MOST LIKELY TO REGRESS. "Approve" and "Approve for session" differ
	 * in exactly one respect, and the difference is invisible at the call site:
	 * both run the call. If the plain row also wrote to the store, the operator
	 * would have handed out a standing grant by answering the narrowest question
	 * the dialog asks, and nothing would ever tell them.
	 */
	it("writes nothing for a plain Approve, so the next call asks again", async () => {
		const store = makeStore();

		const first = await runCall({ store, choice: "Approve" });
		expect(first.text).toBe(RAN);
		expect(store.get("bash")).toBeUndefined();

		const second = await runCall({ store, choice: "Approve" });
		expect(second.selectCalls).toHaveLength(1);
	});

	/** The same for the plain deny row: a refusal now is not a refusal forever. */
	it("writes nothing for a plain Deny, so the next call asks again", async () => {
		const store = makeStore();

		const first = await runCall({ store, choice: "Deny" });
		expect(first.error?.message).toBe("Tool call denied by user: bash");
		expect(store.get("bash")).toBeUndefined();

		const second = await runCall({ store, choice: "Approve" });
		expect(second.selectCalls).toHaveLength(1);
		expect(second.text).toBe(RAN);
	});
});

describe("a session grant against a configured policy", () => {
	/**
	 * A grant made at a dialog can dismiss the prompt it was made at and nothing
	 * above it. `tools.approval.bash: deny` is a rule the operator wrote by hand
	 * in settings; a dialog answer that lifted it would let a single keystroke
	 * silently overwrite configuration, and the error text proves it is the
	 * POLICY refusing rather than the session store.
	 */
	it("still throws the policy error when settings deny the tool", async () => {
		const outcome = await runCall({
			store: makeStore({ bash: "allow" }),
			policies: { bash: "deny" },
		});

		expect(outcome.error?.message).toContain('Tool "bash" is blocked by user policy.');
		expect(outcome.error?.message).not.toContain("denied for this session");
		expect(outcome.text).toBeUndefined();
		expect(outcome.selectCalls).toEqual([]);
	});
});

/**
 * "Approve for session" answers a question about the TOOL NAME. A card raised
 * about one call's arguments asks something else: whether THIS command, THIS
 * path or THIS credential may be used. A grant that retired such a card, or
 * that an answer on such a card recorded, would authorise a later call nobody
 * was asked about: `bash ls` approved for the session, then `bash rm -rf
 * $HOME` running without a prompt.
 */
describe("a session grant answers for the tool name, never for one call's arguments", () => {
	/** The control: the same tool and context, with arguments that raise nothing of their own. */
	it("lets a standing allow run a call whose arguments raise no prompt of their own", async () => {
		const outcome = await runCall({
			tool: argumentScopedTool(),
			context: BOUNDARY_CONTEXT,
			store: makeStore({ bash: "allow" }),
		});

		expect(outcome.text).toBe(RAN);
		expect(outcome.selectCalls).toEqual([]);
	});

	it.each(Object.entries(ARGUMENT_SCOPED))(
		"still asks for %s while the store holds allow",
		async (_reason, params) => {
			const outcome = await runCall({
				tool: argumentScopedTool(),
				context: BOUNDARY_CONTEXT,
				params,
				store: makeStore({ bash: "allow" }),
				choice: "Approve",
			});

			expect(outcome.error).toBeUndefined();
			expect(outcome.selectCalls).toHaveLength(1);
			expect(outcome.text).toBe(RAN);
		},
	);

	it.each(Object.entries(ARGUMENT_SCOPED))(
		"records no grant when the card for %s is answered Approve for session",
		async (_reason, params) => {
			const store = makeStore();

			const first = await runCall({
				tool: argumentScopedTool(),
				context: BOUNDARY_CONTEXT,
				params,
				store,
				choice: "Approve for session",
			});
			expect(first.error).toBeUndefined();
			expect(first.text).toBe(RAN);
			expect(store.get("bash")).toBeUndefined();

			const second = await runCall({
				tool: argumentScopedTool(),
				context: BOUNDARY_CONTEXT,
				store,
				choice: "Approve",
			});
			expect(second.selectCalls).toHaveLength(1);
		},
	);
});
