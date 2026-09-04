/**
 * A per-tool approval policy that is PRESENT and malformed BLOCKS the tool. It does not
 * quietly become "nothing was configured".
 *
 * WHY. `normalizePolicy` returned `undefined` for every value it did not recognize, so a
 * hand-edited `tools.approval.bash: denyy` was indistinguishable from an absent key. On the
 * `yolo` rung the resolver then read `policy: userPolicy ?? "allow"` and AUTO-APPROVED the
 * tool the typo was written to stop — the dangerous direction for a misspelling in a security
 * control, in the configuration where it matters most. The fix fails closed to `deny` (not
 * `prompt`, which the `/yolo` bypass lifts) and names the entry at startup.
 *
 * THE CLASS. Not one misspelling: every non-policy shape a config file can carry — a wrong
 * string, an empty one, whitespace, a boolean, a number, `null` from a YAML key written with
 * no value, an object, an array — on EVERY rung in `APPROVAL_MODE_VALUES`, plus the `/yolo`
 * command's session-wide bypass and an active plan session. The typo set is derived from the
 * valid policies at run time and the valid set is swept from `APPROVAL_POLICY_VALUES` through
 * an exhaustive switch, so adding a fourth policy turns this file RED until someone decides
 * what it does. The block is observed as a side effect that never happened (the stub tool
 * writes a sentinel file), not as a returned string, because "it did not run" is the contract.
 *
 * WHAT IT DOES NOT CATCH. A well-formed policy that is merely wrong for the operator's intent
 * (`allow` where they meant `deny`) is a deliberate-looking choice and nothing here can see
 * it. A `tools.approval` that is not a record at all names no tool, so it configures no
 * policy and every tool runs on its rung; that is asserted below as the limit it is, with the
 * diagnostic as the only recourse. The approval MODE setting is a separate control that fails
 * closed to `ask`, proved by its own suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import { Agent } from "@veyyon/agent-core";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { APPROVAL_POLICY_VALUES, validateApprovalPolicySettings } from "@veyyon/coding-agent/tools/core/approval";
import { APPROVAL_MODE_VALUES } from "@veyyon/coding-agent/tools/core/approval-modes";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { type } from "arktype";
import * as YAML from "yaml";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeDir = useTrackedTempDirs("veyyon-malformed-approval-policy-");

/** Text the tool returns when it runs, so "it ran" is observable in the result too. */
const RAN = "the tool ran";
/** The refusal the wrapper raises for a denied tool. */
const BLOCKED = 'Tool "bash" is blocked by user policy.';

interface Attempt {
	/** Text the tool produced, or undefined when the call threw. */
	text: string | undefined;
	error: Error | undefined;
	/** Card bodies the wrapper put in front of the operator, in order. */
	cards: string[];
	/** True when `execute` actually ran, proved by the file it wrote. */
	sideEffect: boolean;
}

interface AttemptOptions {
	/** Settings the wrapper resolves the policy through. */
	settings: Settings;
	name?: string;
	/** The `/yolo` command's session-wide bypass, stronger than any rung. */
	bypassAllApprovals?: boolean;
	planModeActive?: boolean;
}

let sentinelDir = "";
let sentinelCounter = 0;

/**
 * Run one tool call through the real wrapper and report whether it happened.
 *
 * The stub's `execute` writes a file, which is what makes a refusal falsifiable: a wrapper
 * that threw AFTER running the tool would return no text and look identical to one that
 * blocked, and that is exactly the mistake this suite exists to catch.
 */
async function attempt({
	settings,
	name = "bash",
	bypassAllApprovals,
	planModeActive,
}: AttemptOptions): Promise<Attempt> {
	sentinelCounter += 1;
	const sentinel = path.join(sentinelDir, `ran-${sentinelCounter}`);
	const tool = {
		name,
		label: name,
		summary: "writes a sentinel file when it runs",
		description: "writes a sentinel file when it runs",
		parameters: type({}),
		approval: () => "exec",
		execute: async () => {
			fs.writeFileSync(sentinel, "ran");
			return { content: [{ type: "text", text: RAN }] };
		},
	};
	// A hand-built stub: the wrapper reads only the members spelled above, and `AgentTool`'s
	// generics cannot be satisfied by an untyped literal.
	const asTool = tool as unknown as AgentTool;

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

	const context = {
		settings,
		sessionManager: { getCwd: () => sentinelDir, getSessionId: () => "session-under-test" },
		...(bypassAllApprovals ? { bypassAllApprovals: true } : {}),
		...(planModeActive ? { planModeActive: true } : {}),
	};
	// Assembled per case from the members the wrapper reads; `AgentToolContext` is extended by
	// declaration merging and carries far more than any of them needs.
	const asContext = context as unknown as AgentToolContext;

	const wrapped = new ExtensionToolWrapper(asTool, asRunner);
	try {
		const result = await wrapped.execute("call-1", {}, undefined, undefined, asContext);
		const first = result.content[0];
		const text = first && first.type === "text" ? first.text : undefined;
		return { text, error: undefined, cards, sideEffect: fs.existsSync(sentinel) };
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		return { text: undefined, error, cards, sideEffect: fs.existsSync(sentinel) };
	}
}

/**
 * Load a real settings file, the way an operator's hand-edit arrives.
 *
 * `Settings.isolated` would take the same value from memory and skip the loader, which is
 * half the path the row is about: a YAML file is where `null`, `true` and a bare number come
 * from in the first place.
 */
async function settingsFromFile(tree: Record<string, unknown>): Promise<Settings> {
	const agentDir = makeDir();
	fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(tree));
	return await Settings.loadIsolated({ agentDir, cwd: agentDir });
}

function approvalFile(approval: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { tools: { approval, ...extra } };
}

/**
 * Every non-policy shape, with the near-misses DERIVED from the valid set rather than typed
 * out: a fourth policy automatically gets its own typo, dropped-letter and shouted variants.
 */
const MALFORMED_VALUES: unknown[] = [
	...APPROVAL_POLICY_VALUES.flatMap(policy => [`${policy}y`, policy.slice(0, -1), `${policy.toUpperCase()}!`]),
	"",
	"   ",
	"yes",
	"no",
	"ask",
	true,
	false,
	0,
	1,
	null,
	{},
	{ policy: "deny" },
	[],
	["deny"],
];

describe("a present-but-malformed per-tool policy blocks the tool", () => {
	beforeAll(() => {
		sentinelDir = makeDir();
	});

	/**
	 * The sweep. One expectation for the whole rung ladder, because a malformed control has no
	 * rung on which it may be ignored: the pre-fix code differed from this on `yolo` (it ran the
	 * call) and on every other rung it merely fell through to the rung's own answer, which for
	 * `auto` — the DEFAULT — was also to run it.
	 */
	for (const mode of APPROVAL_MODE_VALUES) {
		it(`refuses every malformed value on the ${mode} rung`, async () => {
			for (const value of MALFORMED_VALUES) {
				const settings = await settingsFromFile(approvalFile({ bash: value }, { approvalMode: mode }));

				const outcome = await attempt({ settings });

				const label = `${mode} / ${JSON.stringify(value)}`;
				expect(`${label}: ${outcome.error?.message}`).toContain(BLOCKED);
				expect(`${label}: ${outcome.sideEffect}`).toBe(`${label}: false`);
				expect(`${label}: ${outcome.text}`).toBe(`${label}: undefined`);
				expect(`${label}: ${outcome.cards.length}`).toBe(`${label}: 0`);
			}
		});
	}

	/**
	 * The `/yolo` command's bypass is the strongest thing in the resolver: it lifts any
	 * remaining prompt to `allow`. That is exactly why the fallback is `deny` and not `prompt` —
	 * a `prompt` fallback would be lifted here and the typo would run the call.
	 */
	it("refuses a malformed value even under the /yolo session bypass", async () => {
		for (const value of MALFORMED_VALUES) {
			const settings = await settingsFromFile(approvalFile({ bash: value }, { approvalMode: "yolo" }));

			const outcome = await attempt({ settings, bypassAllApprovals: true });

			expect(`${JSON.stringify(value)}: ${outcome.error?.message}`).toContain(BLOCKED);
			expect(`${JSON.stringify(value)}: ${outcome.sideEffect}`).toBe(`${JSON.stringify(value)}: false`);
		}
	});

	it("refuses a malformed value inside an active plan session", async () => {
		const settings = await settingsFromFile(approvalFile({ bash: "denyy" }, { approvalMode: "yolo" }));

		const outcome = await attempt({ settings, planModeActive: true });

		expect(outcome.error?.message).toContain(BLOCKED);
		expect(outcome.sideEffect).toBe(false);
	});

	/**
	 * A malformed entry is confined to the tool it names. Failing closed for the whole record
	 * would brick an install over one typo, which is a different defect wearing the same fix.
	 */
	it("blocks only the tool whose entry is malformed", async () => {
		const settings = await settingsFromFile(approvalFile({ bash: "denyy", read: "allow" }, { approvalMode: "yolo" }));

		const blocked = await attempt({ settings, name: "bash" });
		const allowed = await attempt({ settings, name: "read" });

		expect(blocked.error?.message).toContain(BLOCKED);
		expect(blocked.sideEffect).toBe(false);
		expect(allowed.text).toBe(RAN);
		expect(allowed.sideEffect).toBe(true);
	});
});

describe("a well-formed policy is untouched by the fallback", () => {
	beforeAll(() => {
		if (!sentinelDir) sentinelDir = makeDir();
	});

	/**
	 * The differential that keeps the sweep above meaningful. A blanket "deny everything"
	 * would satisfy every refusal in this file, so each valid policy must still do its own
	 * distinct thing on the rung that drops prompts.
	 *
	 * The switch is exhaustive by type AND by throw: a fourth member of
	 * `APPROVAL_POLICY_VALUES` fails the typecheck on `unhandled` and fails this case at run
	 * time, so it cannot be added without deciding what it does here.
	 */
	for (const policy of APPROVAL_POLICY_VALUES) {
		it(`honours a configured ${policy} at yolo`, async () => {
			const settings = await settingsFromFile(approvalFile({ bash: policy }, { approvalMode: "yolo" }));

			const outcome = await attempt({ settings });

			switch (policy) {
				case "allow":
					expect(outcome.text).toBe(RAN);
					expect(outcome.sideEffect).toBe(true);
					expect(outcome.cards).toEqual([]);
					break;
				case "deny":
					expect(outcome.error?.message).toContain(BLOCKED);
					expect(outcome.sideEffect).toBe(false);
					break;
				case "prompt":
					expect(outcome.cards).toHaveLength(1);
					expect(outcome.text).toBe(RAN);
					expect(outcome.sideEffect).toBe(true);
					break;
				default: {
					const unhandled: never = policy;
					throw new Error(`APPROVAL_POLICY_VALUES gained ${JSON.stringify(unhandled)}; decide what it does here`);
				}
			}
		});
	}

	/** Trimming and case-folding are the reason a typo has to be told apart from a spelling. */
	it("still accepts a valid policy written with odd case or padding", async () => {
		for (const spelling of ["ALLOW", " allow ", "Allow"]) {
			const settings = await settingsFromFile(approvalFile({ bash: spelling }, { approvalMode: "yolo" }));

			const outcome = await attempt({ settings });

			expect(`${spelling}: ${outcome.text}`).toBe(`${spelling}: ${RAN}`);
			expect(`${spelling}: ${outcome.sideEffect}`).toBe(`${spelling}: true`);
		}
	});

	/**
	 * The half of the fix that is easy to overshoot: an ABSENT key must stay unconfigured, or
	 * the fallback would deny every tool on a clean install. `auto` is the default rung, so
	 * this is the shape almost every session actually has.
	 */
	it("leaves an absent entry unconfigured, so the rung still decides", async () => {
		const settings = await settingsFromFile(approvalFile({ read: "deny" }));

		const outcome = await attempt({ settings, name: "bash" });

		expect(outcome.text).toBe(RAN);
		expect(outcome.sideEffect).toBe(true);
		expect(outcome.cards).toEqual([]);
	});

	/**
	 * A key that EXISTS carrying `undefined` — what a programmatic override or an SDK caller
	 * produces, where a YAML file can only produce `null`. `Object.hasOwn` says configured and
	 * the value says nothing, and "nothing" is not a malformed policy: denying here would turn
	 * every cleared override into a block. `Settings.isolated` is the only path that can carry
	 * it, which is why this one case does not come from a file.
	 */
	it("leaves a key whose value is undefined unconfigured", async () => {
		const settings = Settings.isolated({ "tools.approval": { bash: undefined, read: "allow" } });

		const outcome = await attempt({ settings });

		expect(outcome.text).toBe(RAN);
		expect(outcome.sideEffect).toBe(true);
		expect(validateApprovalPolicySettings(settings.get("tools.approval"))).toEqual([]);
	});

	it("leaves an empty approval record unconfigured", async () => {
		const settings = await settingsFromFile(approvalFile({}));

		const outcome = await attempt({ settings });

		expect(outcome.text).toBe(RAN);
		expect(outcome.sideEffect).toBe(true);
	});

	/**
	 * The documented limit. A scalar `tools.approval` names no tool, so there is no per-tool
	 * policy to fail closed on and every tool runs on its rung. The diagnostic below is the
	 * only thing standing between that and silence, which is why it exists.
	 */
	it("configures nothing when tools.approval is not a record, and says so", async () => {
		const settings = await settingsFromFile(approvalFile("deny"));

		const outcome = await attempt({ settings });

		expect(outcome.text).toBe(RAN);
		expect(validateApprovalPolicySettings(settings.get("tools.approval"))).toEqual([
			'tools.approval is set to "deny", which is not a per-tool record; every tool policy in it is ignored. ' +
				'Expected { "<tool>": "allow" | "deny" | "prompt" }.',
		]);
	});
});

describe("the operator is told which entry did it", () => {
	/**
	 * A silent fail-closed is its own defect: "bash stopped working" with nothing to read is
	 * indistinguishable from a bug in the tool. The diagnostic has to name the full setting
	 * path, the value found, the fact that the tool is denied, and the values that would work.
	 */
	it("names the path, the value, the consequence and the accepted values", async () => {
		const settings = await settingsFromFile(approvalFile({ bash: "denyy" }));

		const warnings = validateApprovalPolicySettings(settings.get("tools.approval"));

		expect(warnings).toHaveLength(1);
		const warning = warnings[0] ?? "";
		expect(warning).toContain("tools.approval.bash");
		expect(warning).toContain('"denyy"');
		expect(warning).toContain("DENIED");
		for (const policy of APPROVAL_POLICY_VALUES) expect(warning).toContain(policy);
	});

	it("reports one diagnostic per malformed entry and none for the sound ones", async () => {
		const settings = await settingsFromFile(approvalFile({ bash: "denyy", read: "allow", eval: null }));

		const warnings = validateApprovalPolicySettings(settings.get("tools.approval"));

		expect(warnings).toHaveLength(2);
		expect(warnings.some(w => w.startsWith("tools.approval.bash"))).toBe(true);
		expect(warnings.some(w => w.startsWith("tools.approval.eval"))).toBe(true);
		expect(warnings.some(w => w.includes("tools.approval.read"))).toBe(false);
	});

	it("says nothing about a sound record, so a warning means something", async () => {
		const settings = await settingsFromFile(approvalFile({ bash: "deny", read: "allow", eval: "prompt" }));

		expect(validateApprovalPolicySettings(settings.get("tools.approval"))).toEqual([]);
	});

	it("says nothing when the setting is absent", async () => {
		const settings = await settingsFromFile({});

		expect(validateApprovalPolicySettings(settings.get("tools.approval"))).toEqual([]);
	});
});

describe("the session surfaces the diagnostic at startup", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(path.join(makeDir(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		if (session) await session.dispose();
		authStorage.close();
	});

	function makeAgent(): Agent {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected a bundled model for the session fixture");
		const mock = createMockModel();
		return new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (m, context, options) => {
				mock.push({ content: ["ok"] });
				return mock.stream(m, context, options);
			},
		});
	}

	/**
	 * The wiring, not the sentence. `configWarnings` is what interactive mode paints above the
	 * transcript, so a validator nobody calls is a setting that never reaches behavior — the
	 * exact class the fix was written against.
	 */
	it("puts the malformed entry in configWarnings, where the UI paints it", async () => {
		const settings = await settingsFromFile(approvalFile({ bash: "denyy" }));

		session = new AgentSession({
			agent: makeAgent(),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		expect(session.configWarnings.some(w => w.includes("tools.approval.bash") && w.includes("DENIED"))).toBe(true);
	});

	it("says nothing for a sound record, so the warning above is the value and not the path", async () => {
		const settings = await settingsFromFile(approvalFile({ bash: "deny" }));

		const clean = new AgentSession({
			agent: makeAgent(),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		try {
			expect(clean.configWarnings.some(w => w.includes("tools.approval"))).toBe(false);
		} finally {
			await clean.dispose();
		}
	});
});
