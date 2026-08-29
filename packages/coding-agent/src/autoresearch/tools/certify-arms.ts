import { Text } from "@veyyon/tui";
import { formatCount } from "@veyyon/utils";
import { type } from "arktype";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../theme/theme";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { openAutoresearchStorageIfExists } from "../storage";
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
			const certifier = certifierFor(survivors.length);
			const lines: string[] = [];

			lines.push(
				`Triaged ${formatCount("arm", params.arms.length)}: ${survivors.length} surviving, ${rejected.length} rejected.`,
			);
			for (const entry of rejected) {
				lines.push(`- rejected ${entry.arm}: ${entry.reason} (${entry.detail})`);
			}
			if (certificationDegraded(session.breadth, survivors.length)) {
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
				const pairs = certificationPairs(survivors);
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

			const baseline = bestBaseline(measured, session.direction);
			const winner = baseline === null ? null : selectWinner(measured, baseline.worst, session.direction, verdicts);
			for (const verdict of verdicts.values()) {
				if (verdict.flagged)
					lines.push(`- flagged ${verdict.arm} by ${verdict.certifiedBy}: ${verdict.reason ?? "no reason given"}`);
			}
			lines.push(
				winner === null
					? "No arm survived certification with an improvement. Log this iteration as a null round and start the next one."
					: `Winner: ${winner.arm} at ${winner.metric}. Re-apply its diff and log it with log_experiment, passing arm and certified_by.`,
			);

			const runtime = options.getRuntime(ctx);
			options.dashboard.updateWidget(ctx, runtime);

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
		renderCall(args, _options, theme): Text {
			const summary =
				args.verdicts === undefined
					? `triage ${args.arms.length} arms`
					: `verdicts for ${args.verdicts.length} arms`;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("certify_arms"))} ${theme.fg("muted", truncateToWidth(replaceTabs(summary), 100))}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme: Theme): Text {
			const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
			return new Text(theme.fg("muted", text), 0, 0);
		},
	};
}

/**
 * The bar an arm has to clear. Without a recorded baseline for the iteration the
 * worst measured arm stands in, so a winner is still the best of what was tried
 * rather than whichever arm happened to be measured first.
 */
function bestBaseline(
	measured: { arm: string; metric: number }[],
	direction: "lower" | "higher",
): { worst: number } | null {
	if (measured.length === 0) return null;
	const metrics = measured.map(entry => entry.metric);
	return { worst: direction === "higher" ? Math.min(...metrics) : Math.max(...metrics) };
}
