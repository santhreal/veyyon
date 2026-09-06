import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import { type } from "arktype";
import type { ToolDefinition } from "../../extensibility/extensions";
import * as git from "../../utils/git";
import { armIndex, enterArm } from "../arm-model";
import { openAutoresearchStorageIfExists } from "../storage";
import type { AutoresearchToolFactoryOptions } from "../types";

const startArmSchema = type({
	arm: type("string").describe("arm about to be built, `a0` first"),
	"hypothesis?": type("string").describe("what this arm will change, one line"),
});

interface StartArmDetails {
	arm: string;
	model: string;
	switched: boolean;
}

/**
 * The seam that gives one arm its own model.
 *
 * Arms are built serially by the session model, so which arm the next edit
 * belongs to is knowable only if the loop says so. Announcing the arm is also
 * what lets the run screen name the arm in flight instead of showing it only
 * once it has been measured.
 */
export function createStartArmTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof startArmSchema, StartArmDetails> {
	return {
		name: "start_arm",
		label: "Start Arm",
		description:
			"Announce the candidate arm you are about to build, before the first edit for it. Switches the session to the model configured for that arm and marks it in flight on the run screen. Call it once per arm, `a0` first, and log that arm's measurement before starting the next.",
		parameters: startArmSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storage = await openAutoresearchStorageIfExists(ctx.cwd);
			const currentBranch = (await git.branch.current(ctx.cwd)) ?? null;
			const session = storage?.getActiveSessionForBranch(currentBranch) ?? null;
			if (!storage || !session) {
				return {
					content: [
						{
							type: "text",
							text: "Error: no active autoresearch session for the current branch. Call init_experiment first.",
						},
					],
				};
			}

			const arm = params.arm.trim();
			const index = armIndex(arm);
			if (index === null) {
				return {
					content: [{ type: "text", text: `Error: "${params.arm}" is not an arm id. Arms are a0, a1, a2, …` }],
				};
			}
			if (index >= session.breadth) {
				return {
					content: [
						{
							type: "text",
							text: `Error: this session runs ${session.breadth} arms, so ${arm} does not exist. The last arm is a${session.breadth - 1}.`,
						},
					],
				};
			}

			const runtime = options.getRuntime(ctx);
			const outcome = await enterArm(ctx, options.pi, runtime, arm, session.armModels[index]);
			if (!outcome.ok) {
				return { content: [{ type: "text", text: `Error: ${outcome.error}` }] };
			}
			options.dashboard.update(ctx, runtime);
			options.dashboard.requestRender();

			const model = outcome.switched
				? `Switched to ${outcome.modelLabel} for this arm.`
				: `Building on ${outcome.modelLabel}.`;
			return {
				content: [
					{
						type: "text",
						text: `${arm} is in flight. ${model} Every edit until this arm is logged belongs to ${arm}.`,
					},
				],
				details: { arm, model: outcome.modelLabel, switched: outcome.switched },
			};
		},
		view: {
			renderCall: args => {
				const summary = args.hypothesis ? `${args.arm}: ${args.hypothesis}` : args.arm;
				return {
					kind: "textBlock",
					spans: [
						{ text: "start_arm", tone: "title", bold: true },
						{ text: " " },
						{ text: truncateToWidth(replaceTabs(summary), 100), tone: "muted" },
					],
				};
			},
			renderResult: result => ({
				kind: "textBlock",
				spans: [
					{ text: replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), tone: "muted" },
				],
			}),
		},
	};
}
