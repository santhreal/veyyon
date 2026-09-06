import * as path from "node:path";
import { clamp, errorMessage, formatCount, logger } from "@veyyon/utils";
import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import type { TextBlockView } from "@veyyon/view";
import { type } from "arktype";
import type { ToolDefinition } from "../../extensibility/extensions";
import * as git from "../../utils/git";
import { parseWorkDirDirtyPaths, tryReadHeadSha } from "../git";
import { dedupeStrings, gitStatusPorcelain, gitWorkDirPrefix, normalizePathSpec } from "../helpers";
import { buildExperimentState } from "../state";
import { openAutoresearchStorage, type SessionRow } from "../storage";
import { MAX_ATTEMPTS, MAX_BREADTH } from "../swarm";
import type { AutoresearchToolFactoryOptions, ExperimentState } from "../types";
import { activeToolsChanged, activeToolsFor } from ".";

export const HARNESS_FILENAME = "autoresearch.sh";
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;
const HARNESS_COMMIT_TITLE = "autoresearch: harness setup";

/** Undefined leaves the setting alone; a nonsense number is clamped, never rejected. */
function clampCount(value: number | undefined, max: number): number | null {
	if (value === undefined || !Number.isFinite(value)) return null;
	return clamp(Math.floor(value), 1, max);
}

const initExperimentSchema = type({
	name: type("string").describe("experiment name"),
	"goal?": type("string").describe("session goal"),
	primary_metric: type("string").describe("primary metric name"),
	"metric_unit?": type("string").describe("metric unit (e.g. ms, µs, mb)"),
	"direction?": type("'lower' | 'higher'").describe("better direction (default lower)"),
	"secondary_metrics?": type("string[]").describe("secondary metric names"),
	"scope_paths?": type("string[]").describe("expected-to-modify paths"),
	"off_limits?": type("string[]").describe("off-limits paths"),
	"constraints?": type("string[]").describe("free-form constraints"),
	"max_iterations?": type("number").describe("soft iteration cap per segment"),
	"new_segment?": type("boolean").describe("bump to a new segment in existing session"),
	"breadth?": type("number").describe("candidate arms explored per iteration (1 = serial, max 8)"),
	"attempts?": type("number").describe("retries an arm may make before it is abandoned"),
	"certify?": type("boolean").describe("have arms cross-review each other before a winner is kept"),
});

interface InitExperimentDetails {
	state: ExperimentState;
	createdSession: boolean;
	bumpedSegment: boolean;
	abandonedRuns: number;
	harnessCommitted: boolean;
	baselineCommit: string | null;
}

export function createInitExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof initExperimentSchema, InitExperimentDetails> {
	return {
		name: "init_experiment",
		label: "Init Experiment",
		description:
			"Initialize or reconfigure the autoresearch session. On first call (Phase 1 → Phase 2 transition), requires `./autoresearch.sh` to exist and pending harness changes are auto-committed on an autoresearch branch. Pass `new_segment: true` to start a fresh baseline within an existing session.",
		parameters: initExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storage = await openAutoresearchStorage(ctx.cwd);
			const runtime = options.getRuntime(ctx);

			const direction = params.direction ?? "lower";
			// `metric_unit: "comparisons"` beside `primary_metric: "comparisons"` is
			// the name twice, and printed as `1,596,000comparisons` on every surface.
			const unitArg = params.metric_unit?.trim() ?? "";
			const metricUnit = unitArg.toLowerCase() === params.primary_metric.trim().toLowerCase() ? "" : unitArg;
			const scopePaths = dedupeStrings((params.scope_paths ?? []).map(normalizePathSpec));
			const offLimits = dedupeStrings((params.off_limits ?? []).map(normalizePathSpec));
			const constraints = dedupeStrings(params.constraints ?? []);
			const secondaryMetrics = dedupeStrings(params.secondary_metrics ?? []);
			const goal = params.goal?.trim() || null;
			const argIterations =
				params.max_iterations !== undefined && Number.isFinite(params.max_iterations) && params.max_iterations > 0
					? Math.floor(params.max_iterations)
					: null;
			const branch = (await git.branch.current(ctx.cwd)) ?? null;
			const onAutoresearchBranch = branch?.startsWith("autoresearch/") ?? false;

			const existing = storage.getActiveSessionForBranch(branch);
			const isNewSegmentInit = existing !== null && params.new_segment === true;
			const requiresHarness = !existing || isNewSegmentInit;
			// An unset value keeps whatever the session already has, so a plain
			// reconfigure never silently collapses a swarm back to serial.
			// The console parks the operator's answers before a session
			// exists, and they outrank the tool's arguments on the init that
			// consumes them: the model never saw the console, so an argument it
			// passes here is a guess, and a guess of 1 turned a configured swarm
			// into a serial loop with nothing on screen saying so. A later init,
			// with nothing parked, may still reconfigure from what the harness
			// turned out to be.
			const parked = runtime.pendingSwarm;
			const maxIterations = parked?.maxIterations ?? argIterations;
			const breadth = parked?.breadth ?? clampCount(params.breadth, MAX_BREADTH) ?? existing?.breadth ?? 1;
			const attempts = parked?.attempts ?? clampCount(params.attempts, MAX_ATTEMPTS) ?? existing?.attempts ?? 1;
			const certify = parked?.certify ?? params.certify ?? existing?.certify ?? true;
			const overriddenByConsole =
				parked !== null &&
				((params.breadth !== undefined && clampCount(params.breadth, MAX_BREADTH) !== parked.breadth) ||
					(params.attempts !== undefined && clampCount(params.attempts, MAX_ATTEMPTS) !== parked.attempts) ||
					(params.certify !== undefined && params.certify !== parked.certify));
			// Per-arm models are the user's choice in the console, never the
			// model's: this tool takes no argument for them, and a breadth that
			// lands back at 1 drops them, since there are no arms to spread.
			const armModels = breadth > 1 ? (parked?.armModels ?? existing?.armModels ?? []).slice(0, breadth) : [];
			runtime.pendingSwarm = null;

			if (requiresHarness) {
				const harnessExists = await Bun.file(path.join(ctx.cwd, HARNESS_FILENAME)).exists();
				if (!harnessExists) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ./${HARNESS_FILENAME} does not exist. Phase 1 of autoresearch is harness setup — write \`./${HARNESS_FILENAME}\` so it exits 0 and prints \`METRIC <name>=<value>\`, validate it via \`bash ${HARNESS_FILENAME}\`, then call init_experiment again.`,
							},
						],
					};
				}
			}

			let harnessCommitted = false;
			let commitWarning: string | null = null;
			if (requiresHarness && onAutoresearchBranch) {
				const dirty = await detectPendingChanges(ctx.cwd);
				if (dirty) {
					try {
						await git.stage.files(ctx.cwd, []);
						const message = buildHarnessCommitMessage(goal, params.name);
						await git.commit(ctx.cwd, message);
						harnessCommitted = true;
					} catch (err) {
						commitWarning = `Failed to auto-commit harness changes: ${errorMessage(err)}. Recording baseline at current HEAD; discard may not preserve uncommitted harness files.`;
					}
				}
			}

			const baselineCommit = await tryReadHeadSha(ctx.cwd);

			let session: SessionRow;
			let createdSession = false;
			let bumpedSegment = false;
			let abandonedRuns = 0;

			if (!existing) {
				session = storage.openSession({
					name: params.name,
					goal,
					primaryMetric: params.primary_metric,
					metricUnit,
					direction,
					preferredCommand: DEFAULT_HARNESS_COMMAND,
					branch,
					baselineCommit,
					maxIterations,
					scopePaths,
					offLimits,
					constraints,
					secondaryMetrics,
					breadth,
					attempts,
					certify,
					armModels,
				});
				createdSession = true;
			} else if (isNewSegmentInit) {
				abandonedRuns = storage.abandonIncompleteRuns(existing.id);
				storage.bumpSessionSegment(existing.id, baselineCommit);
				session = storage.updateSession(existing.id, {
					goal,
					preferredCommand: DEFAULT_HARNESS_COMMAND,
					maxIterations,
					scopePaths,
					offLimits,
					constraints,
					secondaryMetrics,
					primaryMetric: params.primary_metric,
					metricUnit,
					direction,
					branch,
					baselineCommit,
					breadth,
					attempts,
					certify,
					armModels,
				});
				bumpedSegment = true;
			} else {
				session = storage.updateSession(existing.id, {
					goal: goal ?? existing.goal,
					maxIterations: maxIterations ?? existing.maxIterations,
					scopePaths: params.scope_paths !== undefined ? scopePaths : existing.scopePaths,
					offLimits: params.off_limits !== undefined ? offLimits : existing.offLimits,
					constraints: params.constraints !== undefined ? constraints : existing.constraints,
					secondaryMetrics: params.secondary_metrics !== undefined ? secondaryMetrics : existing.secondaryMetrics,
					primaryMetric: params.primary_metric,
					metricUnit,
					direction,
					branch: branch ?? existing.branch,
					baselineCommit: baselineCommit ?? existing.baselineCommit,
					breadth,
					attempts,
					certify,
					armModels,
				});
			}

			const loggedRuns = storage.listLoggedRuns(session.id);
			const state = buildExperimentState(session, loggedRuns);
			runtime.state = state;
			runtime.goal = session.goal;
			runtime.autoresearchMode = true;
			runtime.autoResumeArmed = true;
			runtime.lastAutoResumePendingRunNumber = null;
			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = null;
			runtime.lastRunNumber = null;
			runtime.lastRunSummary = null;

			options.dashboard.update(ctx, runtime);
			options.dashboard.requestRender();

			// The stored session is the first place the real breadth exists, so this
			// is where a swarm gains `certify_arms` and a serial session loses it.
			// The command path armed the set before the breadth was known.
			const activeTools = options.pi.getActiveTools();
			const nextActiveTools = activeToolsFor(activeTools, true, state.breadth);
			if (activeToolsChanged(activeTools, nextActiveTools)) {
				await options.pi.setActiveTools(nextActiveTools);
			}

			const lines: string[] = [];
			if (createdSession) {
				lines.push(
					`Initialized autoresearch session "${session.name}" (ID ${session.id}) for segment ${session.currentSegment}.`,
				);
			} else if (bumpedSegment) {
				lines.push(
					`Started new segment ${session.currentSegment} for session "${session.name}" (ID ${session.id}).`,
				);
				if (abandonedRuns > 0) {
					lines.push(`Abandoned ${abandonedRuns} incomplete run(s) from prior segment.`);
				}
			} else {
				lines.push(
					`Reconfigured autoresearch session "${session.name}" (ID ${session.id}) on segment ${session.currentSegment}.`,
				);
			}

			if (harnessCommitted) {
				lines.push(`Auto-committed harness setup (${HARNESS_COMMIT_TITLE}).`);
			} else if (commitWarning) {
				lines.push(`Warning: ${commitWarning}`);
			}

			if (session.goal) {
				lines.push(`Goal: ${session.goal}`);
			}
			lines.push(`Primary metric: ${session.primaryMetric} (direction: ${session.direction})`);
			if (session.metricUnit) {
				lines.push(`Metric unit: ${session.metricUnit}`);
			}
			if (session.secondaryMetrics.length > 0) {
				lines.push(`Secondary metrics: ${session.secondaryMetrics.join(", ")}`);
			}
			lines.push(
				session.breadth > 1
					? `Breadth: ${formatCount("arm", session.breadth)} per iteration, ${formatCount("attempt", session.attempts)} each, certification ${session.certify ? "on" : "off"}.`
					: "Breadth: 1 (serial, no arms).",
			);
			if (overriddenByConsole) {
				lines.push(
					"The breadth, attempts and certification arguments were ignored: the console the user configured this run in decides them.",
				);
			}
			if (session.scopePaths.length > 0) {
				lines.push(`Files in scope: ${session.scopePaths.join(", ")}`);
			}
			if (session.offLimits.length > 0) {
				lines.push(`Off limits: ${session.offLimits.join(", ")}`);
			}
			if (session.maxIterations !== null) {
				lines.push(`Max iterations per segment: ${session.maxIterations}`);
			}
			if (session.branch) {
				lines.push(`Active branch: ${session.branch}`);
			}
			if (session.baselineCommit) {
				lines.push(`Baseline commit: ${session.baselineCommit.slice(0, 12)}`);
			}
			if (createdSession) {
				lines.push(
					"Phase 2: iteration loop is active. Run the baseline experiment with `run_experiment` and log it.",
				);
			} else if (bumpedSegment) {
				lines.push("Run a fresh baseline for the new segment.");
			}
			if (requiresHarness && !onAutoresearchBranch) {
				lines.push(
					"Note: not on a dedicated `autoresearch/*` branch — `log_experiment discard` will only revert run-modified files, not reset to baseline.",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					state,
					createdSession,
					bumpedSegment,
					abandonedRuns,
					harnessCommitted,
					baselineCommit: session.baselineCommit,
				},
			};
		},
		view: {
			renderCall: args => initExperimentCallView(args.name),
			renderResult: result => ({
				kind: "textBlock",
				spans: [{ text: replaceTabs(result.content.find(part => part.type === "text")?.text ?? "") }],
			}),
		},
	};
}

/**
 * The card for a call: the tool's name, then the experiment being started.
 *
 * `truncateToWidth` takes an explicit length here because the call is shown in the
 * transcript and on the status row, and a 200-character name wraps and pushes the
 * result off the visible screen. `replaceTabs` is the second sanitization rule: a
 * tab character is a hole in differential terminal rendering.
 */
function initExperimentCallView(name: string): TextBlockView {
	return {
		kind: "textBlock",
		spans: [
			{ text: "init_experiment", tone: "title", bold: true },
			{ text: " " },
			{ text: truncateToWidth(replaceTabs(name), 100), tone: "accent" },
		],
	};
}

/**
 * Whether the worktree has changes that need committing before a baseline is recorded.
 *
 * FAILS CLOSED: a status that cannot be read answers TRUE, not false. The caller commits the harness
 * changes when this is true, and warns that "discard may not preserve uncommitted harness files" when the
 * commit fails -- so answering false on a failure quietly took the branch that loses work, and the
 * baseline was recorded at a HEAD that did not contain the harness. Answering true instead attempts the
 * commit, and a commit that cannot run produces the warning the reader needs to see.
 */
async function detectPendingChanges(cwd: string): Promise<boolean> {
	try {
		const statusText = await gitStatusPorcelain(cwd);
		const workDirPrefix = await gitWorkDirPrefix(cwd);
		return parseWorkDirDirtyPaths(statusText, workDirPrefix).length > 0;
	} catch (err) {
		logger.warn("Git status failed while checking for harness changes; assuming there are some", {
			cwd,
			error: errorMessage(err),
		});
		return true;
	}
}

function buildHarnessCommitMessage(goal: string | null, name: string): string {
	const lines = [HARNESS_COMMIT_TITLE, "", `Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`];
	if (goal) {
		lines.push(`Goal: ${goal}`);
	} else {
		lines.push(`Session: ${name}`);
	}
	return lines.join("\n");
}
