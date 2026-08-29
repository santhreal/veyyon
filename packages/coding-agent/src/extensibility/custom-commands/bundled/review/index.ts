import { errorMessage } from "@veyyon/utils";
import type { BundledCommandAPI, CustomCommand } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import * as git from "../../../../utils/git";
import * as jj from "../../../../utils/jj";
import type { CurrentReviewDiff, ReviewMenuChoice } from "./index-helpers";
import {
	buildCustomReviewPrompt,
	buildHeadlessReviewPrompt,
	buildPrReviewPrompt,
	buildReviewPrompt,
	buildReviewPromptFromDiff,
	extractReviewPrRefFromArgs,
	findRecentPrRefs,
	GIT_UNCOMMITTED_DIFF_INSTRUCTION,
	JJ_UNCOMMITTED_DIFF_INSTRUCTION,
	parseDiff,
	REVIEW_CONTEXT_PR_LIMIT,
} from "./index-helpers";

export class ReviewCommand implements CustomCommand {
	name = "review";
	description = "Launch interactive code review";
	spawnsAgents = ["reviewer"] as const;

	constructor(private api: BundledCommandAPI) {}

	async execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const parsedArgs = extractReviewPrRefFromArgs(args);
		if (parsedArgs.prRef) {
			return buildPrReviewPrompt(this.api, ctx, parsedArgs.prRef, parsedArgs.extraInstructions);
		}

		const extraInstructions = parsedArgs.extraInstructions || undefined;
		if (!ctx.hasUI) {
			return buildHeadlessReviewPrompt(extraInstructions);
		}

		const choices: Array<{ label: string; value: ReviewMenuChoice }> = [
			...findRecentPrRefs(ctx, REVIEW_CONTEXT_PR_LIMIT).map(ref => ({
				label: `Review PR ${ref.repo}#${ref.number} from conversation`,
				value: { kind: "detected-pr" as const, ref },
			})),
			{
				label: "1. Review against a base branch (PR Style)",
				value: { kind: "base-branch" },
			},
			{
				label: "2. Review uncommitted changes",
				value: { kind: "uncommitted" },
			},
			{
				label: "3. Review a specific commit",
				value: { kind: "commit" },
			},
		];

		if (!extraInstructions) {
			choices.push({
				label: "4. Custom review instructions",
				value: { kind: "custom" },
			});
		}

		const selected = await ctx.ui.select(
			"Review Mode",
			choices.map(choice => choice.label),
		);
		if (!selected) return undefined;

		const selectedChoice = choices.find(choice => choice.label === selected)?.value;
		if (!selectedChoice) return undefined;

		switch (selectedChoice.kind) {
			case "detected-pr":
				return buildPrReviewPrompt(this.api, ctx, selectedChoice.ref, extraInstructions ?? "");

			case "base-branch": {
				const branches = await getGitBranches(this.api).catch(err => {
					ctx.ui.notify(`Failed to list branches: ${errorMessage(err)}`, "error");
					return undefined;
				});
				if (!branches) return undefined;
				if (branches.length === 0) {
					ctx.ui.notify("No git branches found", "error");
					return undefined;
				}

				const baseBranch = await ctx.ui.select("Select base branch to compare against", branches);
				if (!baseBranch) return undefined;

				const currentBranch = await git.branch.currentOrHead(this.api.cwd);
				let diffText: string;
				try {
					diffText = await git.diff(this.api.cwd, { base: `${baseBranch}...${currentBranch}` });
				} catch (err) {
					ctx.ui.notify(`Failed to get diff: ${errorMessage(err)}`, "error");
					return undefined;
				}

				return buildReviewPromptFromDiff(
					ctx,
					`Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`,
					diffText,
					extraInstructions,
					`No changes between ${baseBranch} and ${currentBranch}`,
				);
			}

			case "uncommitted": {
				const reviewDiff = await getUncommittedReviewDiff(this.api).catch(err => {
					ctx.ui.notify(`Failed to get diff: ${errorMessage(err)}`, "error");
					return undefined;
				});
				if (!reviewDiff) return undefined;

				return buildReviewPromptFromDiff(
					ctx,
					reviewDiff.mode,
					reviewDiff.diffText,
					extraInstructions,
					reviewDiff.emptyMessage ?? "No diff content found",
					{ diffInstruction: reviewDiff.diffInstruction },
				);
			}

			case "commit": {
				const commits = await getRecentCommits(this.api, 20).catch(err => {
					ctx.ui.notify(`Failed to list commits: ${errorMessage(err)}`, "error");
					return undefined;
				});
				if (!commits) return undefined;
				if (commits.length === 0) {
					ctx.ui.notify("No commits found", "error");
					return undefined;
				}

				const selectedCommit = await ctx.ui.select("Select commit to review", commits);
				if (!selectedCommit) return undefined;

				const hash = selectedCommit.split(" ")[0];

				let diffText: string;
				try {
					diffText = await git.show(this.api.cwd, hash, { format: "" });
				} catch (err) {
					ctx.ui.notify(`Failed to get commit: ${errorMessage(err)}`, "error");
					return undefined;
				}

				return buildReviewPromptFromDiff(
					ctx,
					`Reviewing commit \`${hash}\``,
					diffText,
					extraInstructions,
					"Commit has no diff content",
					{ filteredMessage: "No reviewable files in commit (all changes filtered out)" },
				);
			}

			case "custom": {
				const instructions = await ctx.ui.editor(
					"Enter custom review instructions",
					"Review the following:\n\n",
					undefined,
					{ promptStyle: true },
				);
				if (!instructions?.trim()) return undefined;

				const reviewDiff = await getUncommittedReviewDiff(this.api).catch(err => {
					ctx.ui.notify(`Reviewing without a diff: ${errorMessage(err)}`, "warning");
					return undefined;
				});

				if (reviewDiff?.diffText.trim()) {
					const stats = parseDiff(reviewDiff.diffText);
					return buildReviewPrompt(
						`Custom review: ${instructions.split("\n")[0].slice(0, 60)}…`,
						stats,
						reviewDiff.diffText,
						{
							additionalInstructions: instructions,
							diffInstruction: reviewDiff.diffInstruction,
						},
					);
				}

				return buildCustomReviewPrompt(instructions);
			}
		}
	}
}

async function getGitBranches(api: BundledCommandAPI): Promise<string[]> {
	return git.branch.list(api.cwd, { all: true });
}

async function getGitStatus(api: BundledCommandAPI): Promise<string> {
	return git.status(api.cwd);
}

async function getUncommittedReviewDiff(api: BundledCommandAPI): Promise<CurrentReviewDiff> {
	if (await jj.repo.is(api.cwd)) {
		return {
			diffText: await jj.diff(api.cwd),
			diffInstruction: JJ_UNCOMMITTED_DIFF_INSTRUCTION,
			emptyMessage: "No uncommitted changes found",
			mode: "Reviewing JJ working-copy changes",
		};
	}

	const status = await getGitStatus(api);
	if (!status.trim()) {
		return {
			diffText: "",
			diffInstruction: GIT_UNCOMMITTED_DIFF_INSTRUCTION,
			emptyMessage: "No uncommitted changes found",
			mode: "Reviewing uncommitted changes (staged + unstaged)",
		};
	}

	const [unstagedDiff, stagedDiff] = await Promise.all([git.diff(api.cwd), git.diff(api.cwd, { cached: true })]);
	const combinedDiff = [unstagedDiff, stagedDiff].filter(Boolean).join("\n");
	return {
		diffText: combinedDiff,
		diffInstruction: GIT_UNCOMMITTED_DIFF_INSTRUCTION,
		emptyMessage: "No diff content found",
		mode: "Reviewing uncommitted changes (staged + unstaged)",
	};
}

async function getRecentCommits(api: BundledCommandAPI, count: number): Promise<string[]> {
	return git.log.onelines(api.cwd, count);
}

export default ReviewCommand;
