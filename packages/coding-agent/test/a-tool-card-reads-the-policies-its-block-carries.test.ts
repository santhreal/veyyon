/**
 * WHY: a tool card reads its presentation policies (animate, freeze, give way to the next call,
 * repaint the viewport) on every change and every frame, and building its block to read them
 * projected every view the block carries: a rebuilt 3,959-card transcript built 13,210 blocks for
 * the 3,959 its first frame drew. The producer now resolves the policies without building the
 * block, and this suite proves that shortcut returns what the block would carry.
 *
 * THE CLASS. Any divergence between `ToolExecutionProducer.policies(context)` and
 * `produceBlock(context).display.policies`: a policy resolved from stale parameters after a change,
 * a policy kept across a context change it depends on, or a resolution that drifts from the one the
 * block uses. Every registered tool view is swept at run time and driven through each lifecycle
 * step in each context, reading the policies of one producer as it goes, and compared with a fresh
 * producer replayed to the same step whose block is built.
 *
 * WHAT IT DOES NOT CATCH. A tool that brings its own policies on its tool object rather than in
 * the view registry is resolved by the same function, but no such tool is swept here.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { ToolExecutionPolicies } from "@veyyon/wire/presentation";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ToolExecutionProducer } from "../src/presentation/tool-execution";
import { initTheme } from "../src/theme/theme";
import { toolViewDefinitions } from "../src/tools/view-registry";

const ARGS = {
	action: "run",
	op: "run",
	language: "py",
	code: "print('value')",
	command: "printf value",
	input: "value",
	path: "src/example.ts",
};

/** Details that satisfy every lifecycle predicate the policies read: a running job poll, a todo list, a running agent. */
const LIVE_DETAILS = { jobs: [{ id: "job-1", status: "running" }], phases: [], async: { state: "running" } };

/** Arguments still streaming and longer than a streaming preview shows, which the first result re-anchors. */
const STREAMED_ARGS = { ...ARGS, content: "line\n".repeat(200), __partialJson: '{"command":"printf' };

type Step = (producer: ToolExecutionProducer) => void;

const STEPS: Record<string, Step> = {
	constructed: () => {},
	"arguments replaced": producer => producer.updateArgs(STREAMED_ARGS),
	"arguments complete": producer => producer.setArgsComplete(),
	"partial result": producer =>
		producer.updateResult({ content: [{ type: "text", text: "partial" }], details: LIVE_DETAILS }, true),
	"settled result": producer =>
		producer.updateResult({ content: [{ type: "text", text: "settled" }], details: LIVE_DETAILS }, false),
	"failed result": producer =>
		producer.updateResult({ content: [{ type: "text", text: "failed" }], details: LIVE_DETAILS, isError: true }),
	sealed: producer => producer.seal(),
};

const CONTEXTS = [
	{},
	{ expanded: true },
	{ frozen: true },
	{ expanded: false, frame: 2, frozen: false },
	{ expanded: true, frame: 3, frozen: true },
];

describe("a tool card reads the policies its block carries", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	for (const toolName of Object.keys(toolViewDefinitions)) {
		it(`${toolName}: through every lifecycle step and context`, () => {
			const card = new ToolExecutionProducer({ toolName, args: ARGS, toolCallId: "call-1" });
			const steps = Object.entries(STEPS);
			for (let step = 0; step < steps.length; step++) {
				steps[step][1](card);
				for (const context of CONTEXTS) {
					const reference = new ToolExecutionProducer({ toolName, args: ARGS, toolCallId: "call-1" });
					for (let replay = 0; replay <= step; replay++) steps[replay][1](reference);
					const label = `${steps[step][0]} in ${JSON.stringify(context)}`;
					// The block's display is optional in its type, so both sides are compared as the same optional.
					expect<{ label: string; policies: ToolExecutionPolicies | undefined }>({
						label,
						policies: card.policies(context),
					}).toEqual({ label, policies: reference.produceBlock(context).display?.policies });
				}
			}
		});
	}

	it("reaches every value of every policy the sweep compares", () => {
		const seen = new Map<string, Set<unknown>>();
		const steps = Object.values(STEPS);
		for (const toolName of Object.keys(toolViewDefinitions)) {
			for (let step = 0; step < steps.length; step++) {
				for (const context of CONTEXTS) {
					const reference = new ToolExecutionProducer({ toolName, args: ARGS, toolCallId: "call-1" });
					for (let replay = 0; replay <= step; replay++) steps[replay](reference);
					for (const [key, value] of Object.entries(reference.produceBlock(context).display?.policies ?? {})) {
						const values = seen.get(key) ?? new Set<unknown>();
						seen.set(key, values);
						values.add(value);
					}
				}
			}
		}
		const reached = Object.fromEntries([...seen].map(([key, values]) => [key, [...values].map(String).sort()]));
		expect(reached).toEqual({
			animatedPartialResult: ["false", "true"],
			animatedPendingPreview: ["false", "true"],
			backgroundTaskFrozen: ["false", "true"],
			callIsLiveWidget: ["false", "true"],
			displaceable: ["job", "todo", "undefined"],
			forceFirstResultViewportRepaint: ["false", "true"],
			forceResultViewportRepaintOnSettle: ["false", "true"],
			inline: ["false", "true"],
			mergeCallAndResult: ["false", "true"],
			sealed: ["false", "true"],
		});
	});
});
