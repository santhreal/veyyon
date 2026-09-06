import { formatCount } from "@veyyon/utils";
import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import { type } from "arktype";
import type { ToolDefinition } from "../../extensibility/extensions";
import * as git from "../../utils/git";
import { openAutoresearchStorageIfExists, type RunRow } from "../storage";
import {
	type Candidate,
	certificationDegraded,
	certificationPairs,
	certifierFor,
	RELOCATION_THRESHOLD,
	rank,
	relocatedCost,
	selectWinner,
	triage,
	type Verdict,
} from "../swarm";
import type { AutoresearchToolFactoryOptions } from "../types";

const certifyArmsSchema = type({
	arms: type({
		arm: type("string").describe("arm label, matching the one passed to run_experiment"),
		hypothesis: type("string").describe("what this arm claims to do"),
		diff: type("string").describe("unified diff of the arm's change"),
		modified_paths: type("string[]").describe("paths the arm touched"),
		"metric?": type("number").describe("measured primary metric, once run_experiment has reported it"),
		"cold_metric?": type("number").describe("cost a fresh checkout pays, when the harness reports one"),
	})
		.array()
		.describe("candidate arms to triage"),
	"verdicts?": type({
		arm: type("string").describe("arm that was reviewed"),
		certified_by: type("string").describe("reviewer that produced this verdict"),
		flagged: type("boolean").describe("true when the reviewer judged the arm to be gaming the metric"),
		"reason?": type("string").describe("why the arm was flagged"),
	})
		.array()
		.describe("review outcomes; supply on the second call to pick a winner"),
	"baseline_cold_metric?": type("number").describe("the baseline's cold metric, to detect relocated work"),
});

interface CertifyArmsDetails {
	survivors: number;
	rejected: number;
	certifier: string;
	winner: string | null;
}

export function createCertifyArmsTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof certifyArmsSchema, CertifyArmsDetails> {
	return {
		name: "certify_arms",
		label: "Certify Arms",
		description:
			"Triage the candidate arms of one breadth iteration and assign cross-review. Call once with `arms` to get rejections and review assignments; review the arms you are assigned, then call again with `verdicts` to get the winner. Arms whose diff is unreadable, out of scope, empty, or a duplicate are rejected before measurement counts.",
		parameters: certifyArmsSchema,
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

			const candidates: Candidate[] = params.arms.map(arm => ({
				arm: arm.arm,
				hypothesis: arm.hypothesis,
				diff: arm.diff,
				modifiedPaths: arm.modified_paths,
			}));
			const { survivors, rejected } = triage(candidates, session.offLimits);
			const certifier = certifierFor(survivors.length, session.certify);
			const lines: string[] = [];

			lines.push(
				`Triaged ${formatCount("arm", params.arms.length)}: ${survivors.length} surviving, ${rejected.length} rejected.`,
			);
			for (const entry of rejected) {
				lines.push(`- rejected ${entry.arm}: ${entry.reason} (${entry.detail})`);
			}
			if (certificationDegraded(session.breadth, survivors.length, session.certify)) {
				lines.push(
					`Certification degraded: breadth is ${session.breadth} but only ${survivors.length} arms survived, so review falls back to ${certifier}.`,
				);
			}

			const measured = survivors
				.map(candidate => {
					const supplied = params.arms.find(arm => arm.arm === candidate.arm);
					return supplied?.metric === undefined ? null : { arm: candidate.arm, metric: supplied.metric };
				})
				.filter((entry): entry is { arm: string; metric: number } => entry !== null);

			// Work moved out of the timed region is not an improvement. Report it as a
			// measured fact so the reviewer weighs it rather than trusting the headline.
			if (params.baseline_cold_metric !== undefined) {
				for (const arm of params.arms) {
					if (arm.cold_metric === undefined) continue;
					const delta = relocatedCost({ cold_ms: arm.cold_metric }, { cold_ms: params.baseline_cold_metric });
					if (delta > RELOCATION_THRESHOLD) {
						lines.push(`- ${arm.arm} relocates ${delta.toFixed(1)}ms of cost outside the timed region.`);
					}
				}
			}

			if (params.verdicts === undefined) {
				const pairs = certificationPairs(survivors, session.certify);
				if (pairs.length === 0) {
					lines.push("Nothing to certify.");
				} else {
					lines.push(
						`Certifier: ${certifier}. Review each assignment, then call certify_arms again with verdicts.`,
					);
					for (const pair of pairs) {
						lines.push(`- ${pair.reviewer} reviews ${pair.target}`);
					}
				}
				if (measured.length > 0) {
					const ranked = rank(measured, session.direction);
					lines.push(
						`Ranked so far: ${ranked.map(entry => `${entry.arm}=${entry.metric}`).join(", ")} (${session.direction} is better).`,
					);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { survivors: survivors.length, rejected: rejected.length, certifier, winner: null },
				};
			}

			const verdicts = new Map<string, Verdict>();
			for (const verdict of params.verdicts) {
				verdicts.set(verdict.arm, {
					arm: verdict.arm,
					certifiedBy: verdict.certified_by,
					flagged: verdict.flagged,
					reason: verdict.reason ?? null,
				});
			}

			const runs = storage.listRunsForSegment(session.id, session.currentSegment);
			for (const verdict of verdicts.values()) {
				const run = runs.find(candidate => candidate.arm === verdict.arm);
				if (!run) continue;
				storage.markRunCertified(run.id, verdict.certifiedBy, verdict.flagged, verdict.reason);
			}

			const bar = certificationBar(runs, measured, session.direction);
			const winner = bar === null ? null : selectWinner(measured, bar.metric, session.direction, verdicts);
			for (const verdict of verdicts.values()) {
				if (verdict.flagged)
					lines.push(`- flagged ${verdict.arm} by ${verdict.certifiedBy}: ${verdict.reason ?? "no reason given"}`);
			}
			const barLabel = bar === null ? "baseline" : `${bar.source} of ${bar.metric}`;
			lines.push(
				winner === null
					? `No arm beat the ${barLabel}. Log this iteration as a null round and start the next one.`
					: `Winner: ${winner.arm} at ${winner.metric}, against the ${barLabel}. Re-apply its diff and log it with log_experiment, passing arm and certified_by.`,
			);

			const runtime = options.getRuntime(ctx);
			options.dashboard.update(ctx, runtime);
			options.dashboard.requestRender();

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					survivors: survivors.length,
					rejected: rejected.length,
					certifier,
					winner: winner?.arm ?? null,
				},
			};
		},
		view: {
			renderCall: args => {
				const summary =
					args.verdicts === undefined
						? `triage ${args.arms.length} arms`
						: `verdicts for ${args.verdicts.length} arms`;
				return {
					kind: "textBlock",
					spans: [
						{ text: "certify_arms", tone: "title", bold: true },
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

/**
 * The bar an arm has to clear.
 *
 * The segment's own baseline — its first kept, unflagged logged run, the same
 * rule `findBaselineResult` applies to session state — because the question a
 * breadth iteration answers is whether ANY arm improved on the code that was
 * already there. Ranking the arms against their own worst sibling answers a
 * different question and always has an answer: a round where every arm
 * regressed still elected a winner, which was then logged as an improvement and
 * re-applied. The sibling floor stands in only when the segment has no logged
 * baseline yet, where the alternative is electing no winner at all.
 */
function certificationBar(
	runs: readonly RunRow[],
	measured: readonly { arm: string; metric: number }[],
	direction: "lower" | "higher",
): { metric: number; source: "baseline" | "worst arm" } | null {
	const baseline = runs.find(run => run.status === "keep" && !run.flagged && run.metric !== null);
	if (baseline?.metric != null) return { metric: baseline.metric, source: "baseline" };
	if (measured.length === 0) return null;
	const metrics = measured.map(entry => entry.metric);
	return {
		metric: direction === "higher" ? Math.min(...metrics) : Math.max(...metrics),
		source: "worst arm",
	};
}
