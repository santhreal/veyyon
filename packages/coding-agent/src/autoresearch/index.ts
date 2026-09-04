import * as fs from "node:fs";
import * as path from "node:path";
import type { AutocompleteItem } from "@veyyon/tui";
import { errorMessage, logger, prompt } from "@veyyon/utils";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { autoresearchPrompts } from "../prompts/autoresearch/rows";
import * as git from "../utils/git";
import { leaveArm } from "./arm-model";
import { createDashboardController } from "./dashboard";
import { ensureAutoresearchBranch, parseWorkDirDirtyPaths } from "./git";
import { formatNum, gitStatusPorcelain, gitWorkDirPrefix } from "./helpers";
import { handleSetupKey, renderSetupConsole, SwarmSetupModel, type SwarmSetupResult } from "./setup-console";
import { AUTORESEARCH_SCREEN_KEY } from "./shortcuts";
import {
	buildExperimentState,
	createExperimentState,
	createRuntimeStore,
	currentResults,
	effectiveBreadth,
	findBaselineMetric,
	findBestKeptResult,
	reconstructControlState,
} from "./state";
import { openAutoresearchStorage, openAutoresearchStorageIfExists, type RunRow, type SessionRow } from "./storage";
import { DEFAULT_SWARM_BREADTH } from "./swarm";
import { activeToolsChanged, activeToolsFor, EXPERIMENT_TOOL_NAMES } from "./tools";
import { createCertifyArmsTool } from "./tools/certify-arms";
import { createInitExperimentTool } from "./tools/init-experiment";
import { createLogExperimentTool } from "./tools/log-experiment";
import { createRunExperimentTool } from "./tools/run-experiment";
import { createStartArmTool } from "./tools/start-arm";
import { createUpdateNotesTool } from "./tools/update-notes";
import type { AutoresearchRuntime, ExperimentResult, PendingRunSummary } from "./types";

export const createAutoresearchExtension: ExtensionFactory = api => {
	const runtimeStore = createRuntimeStore();
	const dashboard = createDashboardController();

	const getSessionKey = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime => runtimeStore.ensure(getSessionKey(ctx));

	const loadActiveSession = async (
		ctx: ExtensionContext,
	): Promise<{ session: SessionRow | null; currentBranch: string | null; pausedOnBranch: string | null }> => {
		const currentBranch = await tryReadBranch(ctx.cwd);
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		if (!storage) return { session: null, currentBranch, pausedOnBranch: null };
		const onBranch = storage.getActiveSessionForBranch(currentBranch);
		if (onBranch) return { session: onBranch, currentBranch, pausedOnBranch: null };
		// Nothing recorded for this branch. An active session on another branch is
		// paused, not absent: the caller keeps its runs readable and names the
		// branch, rather than showing a loop that looks reset to nothing.
		const elsewhere = storage.getActiveSession();
		if (!elsewhere || elsewhere.branch === null || elsewhere.branch === currentBranch) {
			return { session: elsewhere, currentBranch, pausedOnBranch: null };
		}
		return { session: elsewhere, currentBranch, pausedOnBranch: elsewhere.branch };
	};

	const rehydrate = async (ctx: ExtensionContext): Promise<void> => {
		const runtime = getRuntime(ctx);
		const control = reconstructControlState(ctx.sessionManager.getBranch());
		runtime.goal = control.goal;
		runtime.autoResumeArmed = false;
		runtime.lastAutoResumePendingRunNumber = null;

		// Skip storage entirely if autoresearch was never activated in this conversation.
		// This is the common case: every project gets a session_start event but most
		// never touch autoresearch, so we must not create a SQLite file just to look.
		const everActivated = control.lastMode !== null;
		const { session, pausedOnBranch } = everActivated
			? await loadActiveSession(ctx)
			: { session: null, pausedOnBranch: null };

		// Mode is effective only on the branch the session recorded. Off that branch
		// the experiment tools detach, but the loop is paused rather than gone: its
		// runs stay loaded, so the run screen still opens and the row can name the
		// branch instead of blanking to a state that looks like nothing ever ran.
		runtime.pausedOnBranch = pausedOnBranch;
		runtime.autoresearchMode = control.autoresearchMode && pausedOnBranch === null;

		if (session) {
			const storage = await openAutoresearchStorageIfExists(ctx.cwd);
			if (storage) {
				const loggedRuns = storage.listLoggedRuns(session.id);
				runtime.state = buildExperimentState(session, loggedRuns);
				runtime.goal = runtime.goal ?? session.goal;
				runtime.lastRunSummary = pendingRunSummaryFromRow(storage.getPendingRun(session.id));
			} else {
				runtime.state = createExperimentState();
				runtime.lastRunSummary = null;
			}
		} else {
			runtime.state = createExperimentState();
			runtime.lastRunSummary = null;
		}
		runtime.lastRunDuration = runtime.lastRunSummary?.durationSeconds ?? null;
		runtime.lastRunAsi = runtime.lastRunSummary?.parsedAsi ?? null;
		runtime.lastRunArtifactDir = runtime.lastRunSummary?.runDirectory ?? null;
		runtime.lastRunNumber = runtime.lastRunSummary?.runNumber ?? null;
		runtime.runningExperiment = null;
		dashboard.update(ctx, runtime);

		const activeTools = api.getActiveTools();
		const nextActiveTools = activeToolsFor(activeTools, runtime.autoresearchMode, effectiveBreadth(runtime));
		if (activeToolsChanged(activeTools, nextActiveTools)) {
			await api.setActiveTools(nextActiveTools);
		}
	};

	const setMode = (
		ctx: ExtensionContext,
		enabled: boolean,
		goal: string | null,
		mode: "on" | "off" | "clear",
	): void => {
		const runtime = getRuntime(ctx);
		runtime.autoresearchMode = enabled;
		// An explicit on or off outranks a pause. Leaving it set would keep the row
		// reading `paused` after the loop was turned off, since a pause is on its
		// own reason to report one.
		runtime.pausedOnBranch = null;
		runtime.autoResumeArmed = false;
		runtime.goal = goal;
		runtime.lastAutoResumePendingRunNumber = null;
		api.appendEntry("autoresearch-control", goal ? { mode, goal } : { mode });
	};

	api.registerTool(createInitExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createRunExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createLogExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createUpdateNotesTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createCertifyArmsTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createStartArmTool({ dashboard, getRuntime, pi: api }));

	// `/autoresearch` and `/autoswarm` are one engine reached two ways. Autoswarm
	// is autoresearch with breadth: same session, same tools, same store, plus
	// arms and certification. Autoresearch stays serial and is never given a
	// breadth control, so nothing about the serial loop changes.
	interface ModeCommandSpec {
		label: string;
		/** The command as a user types it, for a message that names a subcommand. */
		command: string;
		/** Autoswarm opens the setup console and runs with breadth; autoresearch stays serial. */
		swarm: boolean;
	}

	/**
	 * The most consecutive turns the loop nudges a model that is not advancing it.
	 * Two, because the longest legitimate run of turns with no measurement in them
	 * is `init_experiment`, then `start_arm`, then the `run_experiment` that ends
	 * the drought: a smaller budget stops a session that is still opening.
	 */
	const MAX_STALL_NUDGES = 2;

	/** Which of the two commands a session is running as, for the messages a user reads. */
	const modeLabel = (runtime: AutoresearchRuntime): string =>
		effectiveBreadth(runtime) > 1 ? "Autoswarm" : "Autoresearch";

	const disableMode = async (
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		label: string,
		/** Why the loop stopped, when it stopped itself rather than being turned off. */
		reason?: string,
	): Promise<void> => {
		setMode(ctx, false, runtime.goal, "off");
		// Leaving mid-arm must not leave the user on that arm's model.
		const exit = await leaveArm(api, runtime);
		dashboard.update(ctx, runtime);
		await api.setActiveTools(activeToolsFor(api.getActiveTools(), false, effectiveBreadth(runtime)));
		const head = reason ? `${label} stopped: ${reason}` : `${label} mode disabled`;
		if (exit.strandedOn) {
			ctx.ui.notify(
				`${head}, but your model could not be restored. The session is still on ${exit.strandedOn}.`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(exit.restored ? `${head}, and your model restored` : head, reason ? "warning" : "info");
	};

	/**
	 * Opens the autoswarm setup console and resolves to the chosen configuration,
	 * or to null when the user leaves without starting. `prefill` is whatever was
	 * typed after the command, so `/autoswarm make startup faster` lands in the
	 * goal field rather than being parsed as arguments.
	 */
	async function openSwarmSetupConsole(ctx: ExtensionContext, prefill: string): Promise<SwarmSetupResult | null> {
		const runtime = getRuntime(ctx);
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		const session = storage?.getActiveSessionForBranch(await tryReadBranch(ctx.cwd)) ?? null;
		// Open on what this branch is already doing, so reconfiguring a live swarm
		// shows its real breadth instead of the default.
		const model = new SwarmSetupModel({
			goal: prefill.length > 0 ? prefill : (session?.goal ?? runtime.goal ?? ""),
			breadth: session?.breadth ?? runtime.pendingSwarm?.breadth ?? DEFAULT_SWARM_BREADTH,
			attempts: session?.attempts ?? runtime.pendingSwarm?.attempts ?? 1,
			certify: session?.certify ?? runtime.pendingSwarm?.certify ?? true,
			armModels: session?.armModels ?? runtime.pendingSwarm?.armModels ?? [],
			// The console refuses a spec nothing matches, through the resolver
			// `--model` selection uses, so a typo is caught at the row rather than
			// leaving the arm silently on the session model mid-run.
			modelExists: (spec: string) => ctx.models.resolve(spec) !== undefined,
		});
		return await ctx.ui.custom<SwarmSetupResult | null>(
			(tui, theme, _keybindings, done) => ({
				render: (width: number) => renderSetupConsole(model, width, theme),
				handleInput: (data: string): void => {
					const outcome = handleSetupKey(model, data);
					if (outcome === "start") done(model.result());
					else if (outcome === "cancel") done(null);
					else tui.requestRender();
				},
			}),
			{ overlay: true },
		);
	}

	const runModeCommand = async (args: string, ctx: ExtensionContext, spec: ModeCommandSpec): Promise<void> => {
		const trimmed = args.trim();
		const runtime = getRuntime(ctx);

		// A bare command on a live loop is a request to LOOK at it, never to end
		// it. Ending one is `off`, a word typed on purpose:
		// reaching for `/autoswarm` to check on a run and having the mode fall out
		// from under you is the same keystroke meaning two opposite things.
		if (trimmed === "off") {
			await disableMode(ctx, runtime, spec.label);
			return;
		}
		// `status` is the word a user reaches for to CHECK a run, and it used to be
		// swallowed as the goal: `/autoresearch status` on a 20-run session
		// overwrote its goal with "status" and fed that back to the model as the
		// thing to optimize. Both commands answer it with the screen, running or
		// not.
		if (trimmed === "status") {
			await dashboard.showScreen(ctx, runtime);
			return;
		}

		// A live session's goal changes only where it is typed on purpose: this
		// subcommand, or the setup console's goal field. Free text after the
		// command is context for the resume and never a rewrite of the goal.
		let explicitGoal: string | null = null;
		if (trimmed === "goal" || trimmed.startsWith("goal ")) {
			explicitGoal = trimmed === "goal" ? "" : trimmed.slice("goal ".length).trim();
			if (explicitGoal.length === 0) {
				ctx.ui.notify(`\`goal\` needs the text to optimize: /${spec.command} goal <what to optimize>`, "error");
				return;
			}
		}
		const freeText = explicitGoal ?? trimmed;
		if (trimmed === "" && runtime.autoresearchMode && !spec.swarm) {
			await dashboard.showScreen(ctx, runtime);
			return;
		}

		if (trimmed === "clear" || trimmed.startsWith("clear ")) {
			const flags = trimmed === "clear" ? [] : trimmed.slice("clear ".length).trim().split(/\s+/).filter(Boolean);
			// Tokens, not a substring scan: `--keeptree` used to match nothing and
			// fall through to the destructive default, so one typo reset the tree.
			const unknown = flags.filter(flag => flag !== "--keep-tree" && flag !== "--reset-tree");
			if (unknown.length > 0) {
				ctx.ui.notify(
					`Unknown option ${unknown.join(", ")}. \`clear\` takes --keep-tree or --reset-tree; nothing was reset.`,
					"error",
				);
				return;
			}
			await handleClear(ctx, runtime, {
				keepTree: flags.includes("--keep-tree"),
				resetTreeForce: flags.includes("--reset-tree"),
			});
			return;
		}

		// Autoswarm is configured in a console rather than through arguments, so
		// whatever was typed after the command prefills the goal it opens with.
		let swarmSetup: SwarmSetupResult | null = null;
		if (spec.swarm) {
			swarmSetup = await openSwarmSetupConsole(ctx, trimmed);
			if (!swarmSetup) return;
			runtime.pendingSwarm = {
				breadth: swarmSetup.breadth,
				attempts: swarmSetup.attempts,
				certify: swarmSetup.certify,
				armModels: swarmSetup.armModels,
			};
		}

		const goalArg = swarmSetup?.goal ?? (freeText.length > 0 ? freeText : null);
		const branchResult = await ensureAutoresearchBranch(api, ctx.cwd, goalArg ?? runtime.goal);
		if (!branchResult.ok) {
			ctx.ui.notify(branchResult.error, "error");
			return;
		}
		if (branchResult.warning) {
			ctx.ui.notify(branchResult.warning, "warning");
		}

		// Look up an existing session for the branch we just landed on. A session
		// recorded under a different autoresearch/* branch is intentionally ignored
		// — the command on a fresh branch starts a fresh session. Only open the
		// DB if it already exists; the empty-state path must not create one.
		const existingStorage = await openAutoresearchStorageIfExists(ctx.cwd);
		const existingSession = existingStorage?.getActiveSessionForBranch(branchResult.branchName) ?? null;
		const resumeContext = swarmSetup?.goal ?? (explicitGoal === null ? trimmed : "");
		const branchStatusLine = branchResult.branchName
			? branchResult.created
				? `Created and checked out dedicated git branch \`${branchResult.branchName}\` before resuming.`
				: `Using dedicated git branch \`${branchResult.branchName}\`.`
			: "Continuing on the current branch — no autoresearch branch was created.";

		if (existingSession && existingStorage) {
			// Only a goal typed on purpose is written. Free text reaches the model
			// as resume context, with the stored goal left as it was.
			const deliberateGoal = swarmSetup?.goal ?? explicitGoal;
			if (deliberateGoal) existingStorage.updateSession(existingSession.id, { goal: deliberateGoal });
			else if (trimmed.length > 0) {
				ctx.ui.notify(
					`Session goal unchanged. Use \`/${spec.command} goal <text>\` to change what this session optimizes.`,
					"info",
				);
			}
			if (branchResult.branchName) {
				existingStorage.updateSession(existingSession.id, { branch: branchResult.branchName });
			}
			// A session already running serially is raised to the breadth just
			// chosen, so the console governs the resumed run too.
			if (swarmSetup) {
				existingStorage.updateSession(existingSession.id, {
					breadth: swarmSetup.breadth,
					attempts: swarmSetup.attempts,
					certify: swarmSetup.certify,
					maxParallel: swarmSetup.breadth,
					armModels: swarmSetup.armModels,
				});
				runtime.pendingSwarm = null;
			}
			const refreshed = existingStorage.getSessionById(existingSession.id) ?? existingSession;
			runtime.state = buildExperimentState(refreshed, existingStorage.listLoggedRuns(refreshed.id));
			runtime.goal = refreshed.goal ?? goalArg;
			setMode(ctx, true, runtime.goal, "on");
			dashboard.update(ctx, runtime);
			await api.setActiveTools(activeToolsFor(api.getActiveTools(), true, effectiveBreadth(runtime)));
			api.sendUserMessage(
				prompt.render(autoresearchPrompts["autoresearch/command-resume"].text, {
					branch_status_line: branchStatusLine,
					has_resume_context: resumeContext.length > 0,
					resume_context: resumeContext,
				}),
			);
			return;
		}

		setMode(ctx, true, goalArg, "on");
		dashboard.update(ctx, runtime);
		await api.setActiveTools(activeToolsFor(api.getActiveTools(), true, effectiveBreadth(runtime)));
		if (goalArg !== null) {
			api.sendUserMessage(goalArg);
		} else {
			ctx.ui.notify(`${spec.label} enabled—describe what to optimize in your next message.`, "info");
		}
	};

	// Every subcommand is listed before a letter is typed: one nobody can see is
	// one nobody finds, and reaching for an unlisted word used to overwrite the
	// goal. Breadth is not among them — autoswarm is configured in its console.
	function modeCompletions(argumentPrefix: string): AutocompleteItem[] | null {
		const normalized = argumentPrefix.trim().toLowerCase();
		if (normalized.startsWith("clear")) {
			return [
				{ label: "--keep-tree", value: "clear --keep-tree", description: "Close the session, leave your files" },
				{
					label: "--reset-tree",
					value: "clear --reset-tree",
					description: "Reset to baseline even off an autoresearch branch",
				},
			];
		}
		if (argumentPrefix.includes(" ")) return null;
		const completions: AutocompleteItem[] = [
			{ label: "status", value: "status", description: "Open the run screen: goal, runs, arms" },
			{ label: "goal", value: "goal ", description: "Change what this session optimizes" },
			{ label: "off", value: "off", description: "Leave the mode, keep the session" },
			{
				label: "clear",
				value: "clear",
				description: "Reset worktree to baseline and close the active session",
			},
		];
		const filtered =
			normalized.length === 0 ? completions : completions.filter(item => item.label.startsWith(normalized));
		return filtered.length > 0 ? filtered : null;
	}

	api.registerCommand("autoresearch", {
		description: `Run an optimization loop. Bare opens the run screen (${AUTORESEARCH_SCREEN_KEY}); also status, goal <text>, off, clear.`,
		getArgumentCompletions: modeCompletions,
		handler: (args, ctx) =>
			runModeCommand(args, ctx, { label: "Autoresearch", command: "autoresearch", swarm: false }),
	});

	api.registerCommand("autoswarm", {
		description:
			"Autoresearch with breadth: opens a setup console, then explores several candidate arms per iteration.",
		getArgumentCompletions: modeCompletions,
		handler: (args, ctx) => runModeCommand(args, ctx, { label: "Autoswarm", command: "autoswarm", swarm: true }),
	});

	api.registerShortcut(AUTORESEARCH_SCREEN_KEY, {
		description: "Open the autoresearch run screen",
		handler(ctx): Promise<void> {
			// Reachable before the first run, on purpose: the screen is where the
			// goal, the scope and the harness are read, and those exist before any
			// measurement does. It used to reject the command with "no results yet",
			// which is when the configured values are most worth checking.
			return dashboard.showScreen(ctx, getRuntime(ctx));
		},
	});

	api.on("session_start", (_event, ctx) => rehydrate(ctx));
	api.on("session_switch", (_event, ctx) => rehydrate(ctx));
	api.on("session_branch", (_event, ctx) => rehydrate(ctx));
	api.on("session_tree", (_event, ctx) => rehydrate(ctx));
	api.on("session_shutdown", (_event, ctx) => {
		dashboard.clear(ctx);
		runtimeStore.clear(getSessionKey(ctx));
	});

	// Whether the model touched the loop at all is the difference between a turn
	// that stopped mid-setup and one that ignored the loop entirely, and a stall
	// is diagnosed from the log line that says which happened.
	api.on("tool_execution_end", (event, ctx) => {
		if (!EXPERIMENT_TOOL_NAMES.includes(event.toolName)) return;
		getRuntime(ctx).loopToolRanThisTurn = true;
	});

	api.on("agent_end", async (_event, ctx) => {
		const runtime = getRuntime(ctx);
		runtime.runningExperiment = null;
		dashboard.update(ctx, runtime);
		dashboard.requestRender();
		if (!runtime.autoresearchMode) return;
		if (ctx.hasPendingMessages()) {
			runtime.autoResumeArmed = false;
			return;
		}
		const { session } = await loadActiveSession(ctx);
		const storage = session ? await openAutoresearchStorageIfExists(ctx.cwd) : null;
		const pendingRow = session && storage ? storage.getPendingRun(session.id) : null;
		const pendingRun = pendingRunSummaryFromRow(pendingRow);
		runtime.lastRunSummary = pendingRun;
		runtime.lastRunDuration = pendingRun?.durationSeconds ?? runtime.lastRunDuration;
		runtime.lastRunAsi = pendingRun?.parsedAsi ?? runtime.lastRunAsi;
		const shouldResumePendingRun =
			pendingRun !== null && runtime.lastAutoResumePendingRunNumber !== pendingRun.runNumber;
		if (!shouldResumePendingRun && !runtime.autoResumeArmed) {
			// The turn ended with the loop untouched: nothing armed a resume, no
			// measurement is waiting, so there is no next step and nobody is coming.
			// Returning here is what left a live-looking row above a loop that had
			// stopped -- the mode stayed on, the tools stayed attached, and the
			// session sat until the user typed something.
			runtime.stallNudges += 1;
			logger.warn("autoresearch loop ended a turn without advancing", {
				sessionId: session?.id ?? null,
				stallNudges: runtime.stallNudges,
				toolRanThisTurn: runtime.loopToolRanThisTurn,
			});
			if (runtime.stallNudges > MAX_STALL_NUDGES) {
				runtime.stallNudges = 0;
				const label = modeLabel(runtime);
				await disableMode(
					ctx,
					runtime,
					label,
					`the model ended ${MAX_STALL_NUDGES + 1} turns without advancing the experiment. The session and its runs are kept, \`/${label.toLowerCase()} status\` shows them`,
				);
				return;
			}
			api.sendMessage(
				{
					customType: "autoresearch-stall-nudge",
					content: prompt.render(autoresearchPrompts["autoresearch/stall-nudge"].text, {
						has_session: Boolean(session),
					}),
					display: false,
					attribution: "agent",
				},
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			return;
		}
		runtime.stallNudges = 0;
		runtime.autoResumeArmed = false;
		runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null;
		api.sendMessage(
			{
				customType: "autoresearch-resume",
				content: prompt.render(autoresearchPrompts["autoresearch/resume-message"].text, {
					has_pending_run: Boolean(pendingRun),
				}),
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	});

	api.on("before_agent_start", async (event, ctx) => {
		const runtime = getRuntime(ctx);
		runtime.loopToolRanThisTurn = false;
		// A paused loop keeps re-checking. This handler is the only one that notices
		// a git checkout mid-conversation -- `session_branch` is the conversation
		// tree branching, not the repository -- so returning here on a paused
		// runtime would strand the loop until the session was restarted, however
		// many times the user checked the branch back out.
		if (!runtime.autoresearchMode && runtime.pausedOnBranch === null) return;
		// Re-check git branch on every agent start. Off the session's branch the
		// experiment tools detach and the autoresearch system prompt is not
		// injected, but the loop is paused rather than discarded: its runs stay
		// loaded so the run screen still opens, and the row names the branch that
		// resumes it.
		const { session, pausedOnBranch } = await loadActiveSession(ctx);
		if (pausedOnBranch !== null) {
			runtime.pausedOnBranch = pausedOnBranch;
			runtime.autoresearchMode = false;
			runtime.runningExperiment = null;
			const pausedStorage = await openAutoresearchStorageIfExists(ctx.cwd);
			if (session && pausedStorage) {
				runtime.state = buildExperimentState(session, pausedStorage.listLoggedRuns(session.id));
				runtime.lastRunSummary = pendingRunSummaryFromRow(pausedStorage.getPendingRun(session.id));
			}
			dashboard.update(ctx, runtime);
			await api.setActiveTools(activeToolsFor(api.getActiveTools(), false, effectiveBreadth(runtime)));
			return;
		}
		const resumed = runtime.pausedOnBranch !== null;
		if (resumed) {
			// Back on the session's branch. The pause itself records that mode was on
			// when it was taken, so resuming is not a guess.
			runtime.pausedOnBranch = null;
			runtime.autoresearchMode = true;
			await api.setActiveTools(activeToolsFor(api.getActiveTools(), true, effectiveBreadth(runtime)));
		}
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		if (session && storage) {
			runtime.state = buildExperimentState(session, storage.listLoggedRuns(session.id));
		}
		const pendingRow = session && storage ? storage.getPendingRun(session.id) : null;
		const pendingRun = pendingRunSummaryFromRow(pendingRow);
		runtime.lastRunSummary = pendingRun;
		runtime.lastRunDuration = pendingRun?.durationSeconds ?? runtime.lastRunDuration;
		runtime.lastRunAsi = pendingRun?.parsedAsi ?? runtime.lastRunAsi;
		// The row still reads `paused` until it is repainted, and this is the first
		// point where the state behind it is the resumed one rather than the state
		// the pause was taken with.
		if (resumed) dashboard.update(ctx, runtime);
		const state = runtime.state;
		// `event.systemPrompt` is typed `string[]`, but upstream code paths can leave
		// it unset (issue #3665). Coerce defensively so the autoresearch block still
		// renders — the model just loses the upstream prefix for this turn, which is
		// strictly better than crashing the handler.
		const basePrompt = Array.isArray(event.systemPrompt) ? event.systemPrompt.join("\n\n") : "";
		const currentSegmentResults = currentResults(state.results, state.currentSegment);
		const baselineMetric = findBaselineMetric(state.results, state.currentSegment);
		const bestResult = findBestKeptResult(state.results, state.currentSegment, state.bestDirection);
		const goal = runtime.goal ?? state.goal ?? state.name ?? "";
		const recentResults = currentSegmentResults.slice(-3).map(result => {
			const asiSummary = summarizeExperimentAsi(result);
			return {
				asi_summary: asiSummary,
				description: result.description,
				has_asi_summary: Boolean(asiSummary),
				metric_display: formatNum(result.metric, state.metricUnit),
				run_number: result.runNumber ?? state.results.indexOf(result) + 1,
				status: result.status,
				has_deviations: result.scopeDeviations.length > 0,
				deviations: result.scopeDeviations.join(", "),
				justified: Boolean(result.justification),
				flagged: result.flagged,
				flagged_reason: result.flaggedReason ?? "",
			};
		});
		const unjustifiedRuns = currentSegmentResults
			.filter(r => r.status === "keep" && !r.flagged && r.scopeDeviations.length > 0 && !r.justification)
			.slice(-3)
			.map(r => ({
				run_number: r.runNumber,
				paths: r.scopeDeviations.join(", "),
			}));
		if (!session) {
			const currentBranch = await tryReadBranch(ctx.cwd);
			const onAutoresearchBranch = currentBranch?.startsWith("autoresearch/") ?? false;
			const baselineWarning = onAutoresearchBranch
				? null
				: "Heads up: you are not on a dedicated `autoresearch/*` branch. `log_experiment discard` will only revert run-modified files, not reset to baseline — so harness files written before `init_experiment` may not survive a discard. Clean the worktree and re-run `/autoresearch` if you want full revert safety.";
			return {
				systemPrompt: [
					prompt.render(autoresearchPrompts["autoresearch/prompt-setup"].text, {
						base_system_prompt: basePrompt,
						has_goal: goal.trim().length > 0,
						goal,
						working_dir: ctx.cwd,
						has_branch: Boolean(currentBranch),
						branch: currentBranch ?? "",
						has_baseline_warning: baselineWarning !== null,
						baseline_warning: baselineWarning ?? "",
					}),
				],
			};
		}
		return {
			systemPrompt: [
				prompt.render(autoresearchPrompts["autoresearch/prompt"].text, {
					base_system_prompt: basePrompt,
					has_goal: goal.trim().length > 0,
					goal,
					working_dir: ctx.cwd,
					swarm: session.breadth > 1,
					breadth: session.breadth,
					certify: session.certify,
					has_arm_models: session.armModels.some(spec => spec.length > 0),
					arm_models: session.armModels
						.map((spec, index) => `a${index} on ${spec.length > 0 ? spec : "the session model"}`)
						.join(", "),
					metric_name: state.metricName,
					has_branch: Boolean(state.branch),
					branch: state.branch,
					has_baseline_commit: Boolean(state.baselineCommit),
					baseline_commit: state.baselineCommit ? state.baselineCommit.slice(0, 12) : "",
					has_notes: state.notes.trim().length > 0,
					notes: state.notes,
					current_segment: state.currentSegment + 1,
					current_segment_run_count: currentSegmentResults.length,
					has_baseline_metric: baselineMetric !== null,
					baseline_metric_display: formatNum(baselineMetric, state.metricUnit),
					has_best_result: bestResult !== null,
					best_metric_display: bestResult !== null ? formatNum(bestResult.metric, state.metricUnit) : "-",
					best_run_number: bestResult ? (bestResult.runNumber ?? state.results.indexOf(bestResult) + 1) : null,
					has_recent_results: recentResults.length > 0,
					recent_results: recentResults,
					has_unjustified_runs: unjustifiedRuns.length > 0,
					unjustified_runs: unjustifiedRuns,
					has_pending_run: Boolean(pendingRun),
					pending_run_number: pendingRun?.runNumber,
					pending_run_command: pendingRun?.command,
					pending_run_passed: pendingRun?.passed ?? false,
					has_pending_run_metric: pendingRun?.parsedPrimary !== null && pendingRun?.parsedPrimary !== undefined,
					pending_run_metric_display:
						pendingRun?.parsedPrimary !== null && pendingRun?.parsedPrimary !== undefined
							? formatNum(pendingRun.parsedPrimary, state.metricUnit)
							: null,
				}),
			],
		};
	});

	async function handleClear(
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		opts: { keepTree: boolean; resetTreeForce: boolean },
	): Promise<void> {
		const storage = await openAutoresearchStorage(ctx.cwd);
		const branchName = await tryReadBranch(ctx.cwd);
		// Scoped to the branch: the newest open session may belong to another one,
		// and its baseline is the commit `git reset --hard` below would move this
		// worktree to. Every other caller resolves the session the same way.
		const session = storage.getActiveSessionForBranch(branchName);
		const onAutoresearchBranch = branchName?.startsWith("autoresearch/") ?? false;
		const shouldResetTree = !opts.keepTree && (onAutoresearchBranch || opts.resetTreeForce);
		if (shouldResetTree && session?.baselineCommit) {
			// `git reset --hard` plus `git clean` is the one autoresearch action with
			// nothing behind it: uncommitted work in the worktree is gone, and the
			// command that reaches it is four letters typed after a slash. Prompt, state
			// the commit and the file count, and treat a decline as "clear nothing":
			// `clear --keep-tree` closes the session without touching files.
			const dirty = await dirtyPathCount(ctx.cwd);
			if (dirty === null) {
				// Nothing is reset and the session stays open, so the baseline commit
				// this needs is still recorded when git answers again.
				ctx.ui.notify(
					"Could not read git status, so nothing was reset and the session is still open. Use `clear --keep-tree` to close the session and keep your files.",
					"error",
				);
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Reset worktree to baseline?",
				`Resets to ${session.baselineCommit.slice(0, 12)} and deletes untracked files${
					dirty > 0 ? `, discarding uncommitted changes in ${dirty} ${dirty === 1 ? "file" : "files"}` : ""
				}. Use \`clear --keep-tree\` to close the session and keep your files.`,
			);
			if (!confirmed) {
				ctx.ui.notify("Clear cancelled; nothing was reset.", "info");
				return;
			}
			try {
				await git.reset(ctx.cwd, { hard: true, target: session.baselineCommit });
				await git.clean(ctx.cwd);
				ctx.ui.notify(`Reset worktree to baseline ${session.baselineCommit.slice(0, 12)}.`, "info");
			} catch (err) {
				ctx.ui.notify(`Failed to reset worktree to baseline: ${errorMessage(err)}`, "error");
			}
		} else if (shouldResetTree) {
			ctx.ui.notify("No baseline commit recorded — skipped worktree reset.", "warning");
		}

		removeLegacyArtifacts(ctx.cwd);

		if (session) {
			storage.closeSession(session.id);
		}
		runtime.state = createExperimentState();
		runtime.goal = null;
		runtime.lastRunDuration = null;
		runtime.lastRunAsi = null;
		runtime.lastRunArtifactDir = null;
		runtime.lastRunNumber = null;
		runtime.lastRunSummary = null;
		runtime.pendingSwarm = null;
		// Same reason as `off`: a cleared session leaves nothing behind, including
		// the model an arm switched to.
		const exit = await leaveArm(api, runtime);
		setMode(ctx, false, null, "clear");
		dashboard.update(ctx, runtime);
		await api.setActiveTools(activeToolsFor(api.getActiveTools(), false, effectiveBreadth(runtime)));
		ctx.ui.notify(
			exit.strandedOn
				? `Autoresearch session cleared, but your model could not be restored. The session is still on ${exit.strandedOn}.`
				: "Autoresearch session cleared.",
			exit.strandedOn ? "warning" : "info",
		);
	}
};

const LEGACY_ARTIFACTS = [
	"autoresearch.md",
	"autoresearch.sh",
	"autoresearch.checks.sh",
	"autoresearch.program.md",
	"autoresearch.ideas.md",
	"autoresearch.jsonl",
	"autoresearch.config.json",
	".autoresearch",
];

function removeLegacyArtifacts(workDir: string): void {
	for (const name of LEGACY_ARTIFACTS) {
		const target = path.join(workDir, name);
		try {
			fs.rmSync(target, { recursive: true, force: true });
		} catch (err) {
			logger.warn("Failed to remove legacy autoresearch artifact", {
				path: target,
				error: errorMessage(err),
			});
		}
	}
}

/**
 * How many worktree files a reset would discard, for the confirmation to state,
 * or null when the worktree could not be inspected at all.
 *
 * Null is not zero. The confirmation is the only thing standing in front of
 * `git reset --hard` plus `git clean`, and it earns that by naming what is at
 * stake; a git failure reported as zero turned "discarding uncommitted changes
 * in 3 files" into a prompt that mentioned nothing, and the answer to it erased
 * work the prompt never mentioned.
 */
async function dirtyPathCount(cwd: string): Promise<number | null> {
	try {
		const [statusText, workDirPrefix] = await Promise.all([gitStatusPorcelain(cwd), gitWorkDirPrefix(cwd)]);
		return parseWorkDirDirtyPaths(statusText, workDirPrefix).length;
	} catch (err) {
		logger.warn("Failed to count dirty paths before autoresearch clear", { error: errorMessage(err) });
		return null;
	}
}

function pendingRunSummaryFromRow(row: RunRow | null): PendingRunSummary | null {
	if (!row) return null;
	if (row.status !== null) return null;
	if (row.completedAt === null) return null;
	const passed = row.exitCode === 0 && !row.timedOut;
	return {
		command: row.command,
		durationSeconds: row.durationMs !== null ? row.durationMs / 1000 : null,
		parsedAsi: row.parsedAsi,
		parsedMetrics: row.parsedMetrics,
		parsedPrimary: row.parsedPrimary,
		passed,
		preRunDirtyPaths: row.preRunDirtyPaths,
		runDirectory: path.dirname(row.logPath),
		runNumber: row.id,
		exitCode: row.exitCode,
		timedOut: row.timedOut,
	};
}

function summarizeExperimentAsi(result: ExperimentResult): string | null {
	const hypothesis = typeof result.asi?.hypothesis === "string" ? result.asi.hypothesis.trim() : "";
	const rollback = typeof result.asi?.rollback_reason === "string" ? result.asi.rollback_reason.trim() : "";
	const next = typeof result.asi?.next_action_hint === "string" ? result.asi.next_action_hint.trim() : "";
	const summary = [hypothesis, rollback, next].filter(part => part.length > 0).join(" | ");
	return summary.length > 0 ? summary.slice(0, 220) : null;
}

/**
 * The current branch name, or null when there is not one.
 *
 * Null is the ordinary answer and not a swallowed failure: a detached HEAD has no branch, and a directory
 * that is not a repository has none either, which is the state autoresearch checks for before deciding
 * whether a session applies. The caller treats null as "no autoresearch session for this branch", which
 * is the conservative direction: nothing is started or logged against a branch that could not be named.
 */
async function tryReadBranch(cwd: string): Promise<string | null> {
	try {
		return (await git.branch.current(cwd)) ?? null;
	} catch {
		return null;
	}
}
