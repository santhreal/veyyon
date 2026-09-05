import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AutocompleteItem } from "@veyyon/tui";
import { errorMessage, logger, prompt } from "@veyyon/utils";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { autoresearchPrompts } from "../prompts/autoresearch/rows";
import * as git from "../utils/git";
import { leaveArm } from "./arm-model";
import { type ConsoleAction, type ConsoleHost, LoopConsoleModel, type LoopSetup } from "./console";
import { createDashboardController } from "./dashboard";
import { ensureAutoresearchBranch, parseWorkDirDirtyPaths } from "./git";
import { formatNum, gitStatusPorcelain, gitWorkDirPrefix } from "./helpers";
import { deletePreset, type LoopPreset, loadPresets, savePreset } from "./presets";
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
import { type AutoresearchStorage, openAutoresearchStorageIfExists, type RunRow, type SessionRow } from "./storage";
import { DEFAULT_SWARM_BREADTH } from "./swarm";
import { activeToolsChanged, activeToolsFor, EXPERIMENT_TOOL_NAMES } from "./tools";
import { createCertifyArmsTool } from "./tools/certify-arms";
import { createInitExperimentTool, HARNESS_FILENAME } from "./tools/init-experiment";
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

	/** Whether `./autoresearch.sh` is in the tree: the first thing a fresh loop's turn writes when it is not. */
	const harnessExists = (cwd: string): Promise<boolean> =>
		fs.promises
			.access(path.join(cwd, HARNESS_FILENAME))
			.then(() => true)
			.catch(() => false);
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
		runtime.dispatchedTurnId = null;

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
		runtime.interrupted = false;
		runtime.autoResumeArmed = false;
		runtime.goal = goal;
		runtime.lastAutoResumePendingRunNumber = null;
		runtime.dispatchedTurnId = null;
		api.appendEntry("autoresearch-control", goal ? { mode, goal } : { mode });
	};

	api.registerTool(createInitExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createRunExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createLogExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createUpdateNotesTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createCertifyArmsTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createStartArmTool({ dashboard, getRuntime, pi: api }));

	// `/autoresearch` and `/autoswarm` are one engine reached two ways, and
	// they are two commands on purpose. `/autoresearch` is the serial loop: a
	// goal typed after it starts or resumes, and `status`, `resume`, `goal`,
	// `off` and `clear` are its subcommands. `/autoswarm` is the console: the
	// breadth, per-arm models, attempts, certification and presets a swarm
	// needs, with no arguments. Same session store, same tools; a swarm is a
	// session whose breadth is above 1.

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

	/**
	 * Whether the turn ended because the user interrupted it. The session's own
	 * abort flag is already cleared by the time `agent_end` reaches subscribers,
	 * so this reads the stop reason off the last assistant message instead.
	 */
	const endedByAbort = (messages: readonly AgentMessage[]): boolean => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message.role !== "assistant") continue;
			return message.stopReason === "aborted";
		}
		return false;
	};

	/** The details a dispatched turn's message carries, so `agent_end` can find it in the transcript. */
	const dispatchDetails = (message: AgentMessage): { dispatchId: string } | null => {
		if (message.role !== "custom") return null;
		const details: unknown = message.details;
		if (details === null || typeof details !== "object" || !("dispatchId" in details)) return null;
		return typeof details.dispatchId === "string" ? { dispatchId: details.dispatchId } : null;
	};

	/**
	 * Send a hidden turn on the loop's behalf and remember it until the turn
	 * that carries it ends. The session starts it once the agent is idle, which
	 * can be several turns away when a continuation of its own is queued first.
	 */
	const dispatchTurn = (runtime: AutoresearchRuntime, message: { customType: string; content: string }): void => {
		const dispatchId = randomUUID();
		runtime.dispatchedTurnId = dispatchId;
		api.sendMessage(
			{ ...message, display: false, attribution: "agent", details: { dispatchId } },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	};

	/**
	 * Whether the turn the loop dispatched is still on its way at the end of
	 * another turn. A dispatched message that follows the ended turn's last
	 * assistant message belongs to the turn that has just been accepted; one
	 * that precedes it was consumed, so the loop's diagnosis applies. A message
	 * that is nowhere in the transcript was consumed and compacted away, or
	 * dropped: either way there is nothing coming, and the diagnosis applies.
	 * (A dispatch that has not been accepted yet is queued work the session
	 * reports through `hasPendingMessages`, which the caller checks first.)
	 */
	const dispatchedTurnJustStarted = (messages: readonly AgentMessage[], dispatchId: string | null): boolean => {
		if (dispatchId === null) return false;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message.role === "assistant") return false;
			if (dispatchDetails(message)?.dispatchId === dispatchId) return true;
		}
		return false;
	};

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
	 * The autoswarm surfaces: the launcher before a session exists, the
	 * dashboard over one. A field edited in either is persisted as it is
	 * typed: to the session recorded on this branch, or parked for the start
	 * when there is none yet. An action closes the surface and runs once it
	 * has closed, so a confirmation or a turn never opens under the overlay.
	 */
	async function openSwarmConsole(ctx: ExtensionContext): Promise<void> {
		const runtime = getRuntime(ctx);
		const branch = await tryReadBranch(ctx.cwd);
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		let session = storage?.getActiveSessionForBranch(branch) ?? null;
		// The ledger paints from the runtime, and a session the store holds that
		// the runtime never loaded (opened by another process, or before this one
		// activated the mode) would show a detail pane with no goal or runs.
		if (session && storage && runtime.state.sessionId !== session.id) {
			runtime.state = buildExperimentState(session, storage.listLoggedRuns(session.id));
			runtime.goal = runtime.goal ?? session.goal;
		}
		const harness = session !== null || (await harnessExists(ctx.cwd));
		const parked = runtime.pendingSwarm;
		const initial: LoopSetup = {
			goal: session?.goal ?? runtime.goal ?? "",
			breadth: session?.breadth ?? parked?.breadth ?? DEFAULT_SWARM_BREADTH,
			attempts: session?.attempts ?? parked?.attempts ?? 1,
			certify: session?.certify ?? parked?.certify ?? true,
			armModels: session?.armModels ?? parked?.armModels ?? [],
			maxIterations: session?.maxIterations ?? parked?.maxIterations ?? null,
		};
		let presets: LoopPreset[] | null = null;
		const requested: { action: ConsoleAction | null } = { action: null };
		const host: ConsoleHost = {
			situation: () => ({
				session: session
					? { name: session.name, branch: session.branch, runs: runtime.state.results.length }
					: null,
				harness,
				modeOn: runtime.autoresearchMode,
				busy: !ctx.isIdle(),
				interrupted: runtime.interrupted,
				pausedOnBranch: runtime.pausedOnBranch,
				baseline: session?.baselineCommit != null,
			}),
			modelExists: spec => ctx.models.resolve(spec) !== undefined,
			presets: () => {
				presets ??= loadPresets();
				return presets;
			},
			savePreset: preset => {
				const outcome = savePreset(preset);
				presets = null;
				ctx.ui.notify(
					outcome === "saved"
						? `Preset "${preset.name}" saved.`
						: `"${preset.name}" is built in; pick another name.`,
					outcome === "saved" ? "info" : "warning",
				);
				return outcome;
			},
			deletePreset: name => {
				const removed = deletePreset(name);
				presets = null;
				if (removed) ctx.ui.notify(`Preset "${name}" removed.`, "info");
				return removed;
			},
			apply: setup => {
				if (setup.goal.length > 0) runtime.goal = setup.goal;
				if (session && storage) {
					storage.updateSession(session.id, {
						...(setup.goal.length > 0 ? { goal: setup.goal } : {}),
						attempts: setup.attempts,
						certify: setup.certify,
						maxParallel: setup.breadth,
						armModels: setup.armModels,
						maxIterations: setup.maxIterations,
					});
					session = storage.getSessionById(session.id) ?? session;
					runtime.state = buildExperimentState(session, storage.listLoggedRuns(session.id));
					runtime.pendingSwarm = null;
					dashboard.update(ctx, runtime);
					// Breadth decides which tools a live loop has: the swarm-only
					// tools attach the moment breadth leaves 1, and detach when it
					// returns.
					if (runtime.autoresearchMode) {
						const active = api.getActiveTools();
						const next = activeToolsFor(active, true, effectiveBreadth(runtime));
						if (activeToolsChanged(active, next)) {
							api.setActiveTools(next).catch(err => {
								logger.warn("autoresearch console could not update the active tools", {
									error: errorMessage(err),
								});
							});
						}
					}
					return;
				}
				runtime.pendingSwarm = {
					breadth: setup.breadth,
					attempts: setup.attempts,
					certify: setup.certify,
					armModels: setup.armModels,
					maxIterations: setup.maxIterations,
				};
				dashboard.update(ctx, runtime);
			},
			act: action => {
				requested.action = action;
				return "close";
			},
		};
		const model = new LoopConsoleModel(initial, host);
		if (!ctx.hasUI) {
			// No terminal to draw the console in (`-p`, a pipe).
			ctx.ui.notify(
				"The autoswarm console needs an interactive terminal. `/autoresearch <goal>` starts the serial loop without one.",
				"warning",
			);
			return;
		}
		// Two surfaces: the launcher is the setup card for a branch with nothing
		// on it yet, and the dashboard is the ledger with the actions on keys.
		if (session === null) await dashboard.showLauncher(ctx, model);
		else await dashboard.showScreen(ctx, runtime, model);
		const action = requested.action;
		if (action === null) return;
		if (action === "pause") {
			// `agent_end` reads the abort and reports the pause.
			ctx.abort();
			return;
		}
		if (action === "stop") {
			await disableMode(ctx, runtime, modeLabel(runtime));
			return;
		}
		if (action === "clear" || action === "reset") {
			await handleClear(ctx, runtime, {
				resetTree: action === "reset",
				keepHint: "Clear session closes it and keeps your files.",
			});
			return;
		}
		if (action === "new" && session && storage) {
			// The session on this branch is closed with every file left as it
			// is, and the setup on screen starts the next one on the same branch.
			const runs = storage.listLoggedRuns(session.id).length;
			await closeSession(ctx, runtime, session, storage);
			ctx.ui.notify(
				`Closed ${session.name} · ${runs === 1 ? "1 run" : `${runs} runs`} kept in the store. Starting a new session.`,
				"info",
			);
		}
		await startOrResume(ctx, runtime, model.setup());
	}

	/** The line the resume prompt opens with: which branch the loop is on. */
	const branchStatusLine = (branchResult: { branchName: string | null; created: boolean }): string =>
		branchResult.branchName
			? branchResult.created
				? `Created and checked out dedicated git branch \`${branchResult.branchName}\` before resuming.`
				: `Using dedicated git branch \`${branchResult.branchName}\`.`
			: "Continuing on the current branch — no autoresearch branch was created.";

	/**
	 * Resume `session` on the branch the loop landed on: reload its runs, turn
	 * the mode on, attach the tools and dispatch the resume turn. The prompt is
	 * the model's; the user reads one line stating what is being resumed.
	 */
	async function resumeSession(
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		storage: AutoresearchStorage,
		session: SessionRow,
		branchResult: { branchName: string | null; created: boolean },
		resumeContext: string,
	): Promise<void> {
		runtime.pendingSwarm = null;
		runtime.state = buildExperimentState(session, storage.listLoggedRuns(session.id));
		runtime.goal = session.goal;
		setMode(ctx, true, runtime.goal, "on");
		dashboard.update(ctx, runtime);
		await api.setActiveTools(activeToolsFor(api.getActiveTools(), true, effectiveBreadth(runtime)));
		const runs = runtime.state.results.length;
		const best = findBestKeptResult(runtime.state.results, runtime.state.currentSegment, runtime.state.bestDirection);
		const bestText = best ? ` · best ${formatNum(best.metric, runtime.state.metricUnit)}` : "";
		const where = branchResult.branchName ? ` on \`${branchResult.branchName}\`` : "";
		ctx.ui.notify(
			`Resuming ${modeLabel(runtime).toLowerCase()} ${session.name}${where} · ${runs === 1 ? "1 run" : `${runs} runs`}${bestText}.`,
			"info",
		);
		dispatchTurn(runtime, {
			customType: "autoresearch-command-resume",
			content: prompt.render(autoresearchPrompts["autoresearch/command-resume"].text, {
				branch_status_line: branchStatusLine(branchResult),
				has_resume_context: resumeContext.length > 0,
				resume_context: resumeContext,
			}),
		});
	}

	/**
	 * Start or resume the swarm on its `autoresearch/*` branch with the setup
	 * the console holds. Which of the two it is depends on the branch the loop
	 * lands on, not on the row pressed: `Start` from `main` checks out a branch
	 * that may already carry a session, and that session is resumed with the
	 * new values rather than shadowed by a second one.
	 */
	async function startOrResume(ctx: ExtensionContext, runtime: AutoresearchRuntime, setup: LoopSetup): Promise<void> {
		const goal = setup.goal.length > 0 ? setup.goal : null;
		const branchResult = await ensureAutoresearchBranch(api, ctx.cwd, goal ?? runtime.goal);
		if (!branchResult.ok) {
			ctx.ui.notify(branchResult.error, "error");
			return;
		}
		if (branchResult.warning) ctx.ui.notify(branchResult.warning, "warning");

		// Only open the DB if it already exists; the empty-state path must not
		// create one.
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		const existing = storage?.getActiveSessionForBranch(branchResult.branchName) ?? null;
		if (existing && storage) {
			// A Goal row cleared to nothing is not a request to forget the goal.
			storage.updateSession(existing.id, {
				...(goal !== null ? { goal } : {}),
				branch: branchResult.branchName,
				breadth: setup.breadth,
				attempts: setup.attempts,
				certify: setup.certify,
				maxParallel: setup.breadth,
				armModels: setup.armModels,
				maxIterations: setup.maxIterations,
			});
			await resumeSession(ctx, runtime, storage, storage.getSessionById(existing.id) ?? existing, branchResult, "");
			return;
		}

		runtime.pendingSwarm = {
			breadth: setup.breadth,
			attempts: setup.attempts,
			certify: setup.certify,
			armModels: setup.armModels,
			maxIterations: setup.maxIterations,
		};
		setMode(ctx, true, goal, "on");
		dashboard.update(ctx, runtime);
		await api.setActiveTools(activeToolsFor(api.getActiveTools(), true, effectiveBreadth(runtime)));
		if (goal !== null) {
			api.sendUserMessage(goal);
		} else {
			ctx.ui.notify("Autoswarm enabled—describe what to optimize in your next message.", "info");
		}
	}

	/**
	 * `/autoresearch`: the serial loop. Bare, it opens the run screen on a live
	 * loop and enables the mode otherwise; text after it is the goal of a new
	 * session or context for resuming the one on the branch. The subcommands
	 * are `status`, `resume`, `goal <text>`, `off` and `clear`.
	 */
	async function runAutoresearchCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const trimmed = args.trim();
		const runtime = getRuntime(ctx);

		// A bare command on a live loop is a request to LOOK at it, never to end
		// it. Ending one is `off`, a word typed on purpose: reaching for
		// `/autoresearch` to check on a run and having the mode fall out from
		// under you is the same keystroke meaning two opposite things.
		if (trimmed === "off") {
			await disableMode(ctx, runtime, "Autoresearch");
			return;
		}
		// `status` is the word a user reaches for to CHECK a run, and it used to be
		// swallowed as the goal: `/autoresearch status` on a 20-run session
		// overwrote its goal with "status" and fed that back to the model as the
		// thing to optimize. It is answered with the screen, running or not.
		if (trimmed === "status" || (trimmed === "" && runtime.autoresearchMode)) {
			await dashboard.showScreen(ctx, runtime, null);
			return;
		}
		// `resume` picks an interrupted or paused loop back up with nothing to
		// add: no goal, no context. Any message resumes it too; this is the word
		// for a user who does not know that.
		const resumeWord = trimmed === "resume";
		if (resumeWord) {
			const storage = await openAutoresearchStorageIfExists(ctx.cwd);
			const onBranch = storage?.getActiveSessionForBranch(await tryReadBranch(ctx.cwd)) ?? null;
			if (!onBranch) {
				ctx.ui.notify(
					"No autoresearch session on this branch to resume. /autoresearch <goal> starts one.",
					"warning",
				);
				return;
			}
		}

		// A live session's goal changes only where it is typed on purpose: this
		// subcommand. Free text after the command is context for the resume and
		// never a rewrite of the goal.
		let explicitGoal: string | null = null;
		if (trimmed === "goal" || trimmed.startsWith("goal ")) {
			explicitGoal = trimmed === "goal" ? "" : trimmed.slice("goal ".length).trim();
			if (explicitGoal.length === 0) {
				ctx.ui.notify("`goal` needs the text to optimize: /autoresearch goal <what to optimize>", "error");
				return;
			}
		}
		const freeText = explicitGoal ?? trimmed;

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
			// The tree is reset on an `autoresearch/*` branch, where the baseline
			// is the branch's own; elsewhere only when asked, and never with
			// `--keep-tree`.
			const onAutoresearchBranch = (await tryReadBranch(ctx.cwd))?.startsWith("autoresearch/") ?? false;
			await handleClear(ctx, runtime, {
				resetTree: !flags.includes("--keep-tree") && (onAutoresearchBranch || flags.includes("--reset-tree")),
				keepHint: "Use `clear --keep-tree` to close the session and keep your files.",
			});
			return;
		}

		const goalArg = resumeWord || freeText.length === 0 ? null : freeText;
		const branchResult = await ensureAutoresearchBranch(api, ctx.cwd, goalArg ?? runtime.goal);
		if (!branchResult.ok) {
			ctx.ui.notify(branchResult.error, "error");
			return;
		}
		if (branchResult.warning) ctx.ui.notify(branchResult.warning, "warning");

		// Look up an existing session for the branch we just landed on. A session
		// recorded under a different autoresearch/* branch is intentionally ignored
		// — the command on a fresh branch starts a fresh session. Only open the
		// DB if it already exists; the empty-state path must not create one.
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		const existing = storage?.getActiveSessionForBranch(branchResult.branchName) ?? null;
		if (existing && storage) {
			// Free text is context for the resume, unless it is the goal typed
			// back: `/autoresearch make the tokenizer faster` on the session that
			// already optimizes that is a resume with nothing to add.
			const storedGoal = existing.goal ?? "";
			const resumeContext = explicitGoal === null && goalArg !== null && goalArg !== storedGoal ? goalArg : "";
			if (explicitGoal !== null) storage.updateSession(existing.id, { goal: explicitGoal });
			else if (resumeContext.length > 0) {
				ctx.ui.notify(
					"Your text goes to the model as context for the resume. `/autoresearch goal <text>` changes what this session optimizes.",
					"info",
				);
			}
			if (branchResult.branchName) storage.updateSession(existing.id, { branch: branchResult.branchName });
			await resumeSession(
				ctx,
				runtime,
				storage,
				storage.getSessionById(existing.id) ?? existing,
				branchResult,
				resumeContext,
			);
			return;
		}

		// A serial loop: whatever the autoswarm console parked is not this
		// command's, so `init_experiment` opens the session at breadth 1.
		runtime.pendingSwarm = null;
		setMode(ctx, true, goalArg, "on");
		dashboard.update(ctx, runtime);
		await api.setActiveTools(activeToolsFor(api.getActiveTools(), true, effectiveBreadth(runtime)));
		if (goalArg !== null) {
			api.sendUserMessage(goalArg);
		} else {
			ctx.ui.notify("Autoresearch enabled—describe what to optimize in your next message.", "info");
		}
	}

	// Every subcommand is listed before a letter is typed: one nobody can see is
	// one nobody finds, and reaching for an unlisted word used to overwrite the
	// goal.
	function autoresearchCompletions(argumentPrefix: string): AutocompleteItem[] | null {
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
			{ label: "status", value: "status", description: "Open the run screen: goal, runs, metric" },
			{ label: "resume", value: "resume", description: "Pick an interrupted loop back up" },
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
		description: `Run a serial optimization loop on a goal. Bare opens the run screen (${AUTORESEARCH_SCREEN_KEY}); also status, resume, goal <text>, off, clear.`,
		getArgumentCompletions: autoresearchCompletions,
		handler: runAutoresearchCommand,
	});

	api.registerCommand("autoswarm", {
		description:
			"Open the autoswarm console: goal, breadth, per-arm models, attempts, certification, presets; start, pause, resume, new session, stop and clear. Takes no arguments.",
		handler: (args, ctx) => {
			if (args.trim().length > 0) {
				ctx.ui.notify(
					"`/autoswarm` takes no arguments: the goal and every other setting are set in the console.",
					"warning",
				);
			}
			return openSwarmConsole(ctx);
		},
	});

	api.registerShortcut(AUTORESEARCH_SCREEN_KEY, {
		description: "Open the autoresearch run screen",
		handler(ctx): Promise<void> {
			// Reachable before the first run, on purpose: the screen is where the
			// goal, the scope and the harness are read, and those exist before any
			// measurement does.
			return dashboard.showScreen(ctx, getRuntime(ctx), null);
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

	api.on("agent_end", async (event, ctx) => {
		const runtime = getRuntime(ctx);
		runtime.runningExperiment = null;
		dashboard.update(ctx, runtime);
		dashboard.requestRender();
		if (!runtime.autoresearchMode) return;
		if (endedByAbort(event.messages)) {
			// Escape is the user stopping the loop. Resuming it from here, which
			// this handler did whenever a measurement was waiting, put the loop
			// back on the very next turn and left nothing the interrupt had done.
			// The session keeps its state; the next message the user sends
			// resumes it through `before_agent_start`. Read before the queue: the
			// interrupt drops a turn the loop dispatched, and a message the user
			// queued does not make the loop any less stopped.
			runtime.autoResumeArmed = false;
			runtime.dispatchedTurnId = null;
			runtime.stallNudges = 0;
			runtime.interrupted = true;
			dashboard.update(ctx, runtime);
			const swarm = effectiveBreadth(runtime) > 1;
			ctx.ui.notify(
				swarm
					? "Autoswarm interrupted. Send a message to continue, or open `/autoswarm` to resume, stop or clear it."
					: "Autoresearch interrupted. Send a message or `/autoresearch resume` to continue; `/autoresearch off` stops it.",
				"info",
			);
			return;
		}
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
		if (dispatchedTurnJustStarted(event.messages, runtime.dispatchedTurnId)) {
			// The turn that ended is not the loop's. Its resume or nudge waited
			// behind whatever the session ran first -- a code-review continuation,
			// a queued follow-up -- and has been accepted as the turn starting now.
			// Diagnosing a stall here queued a second hidden turn behind the first,
			// and counted a turn the loop never saw against its stall budget.
			return;
		}
		runtime.dispatchedTurnId = null;
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
					`the model ended ${MAX_STALL_NUDGES + 1} turns without advancing the experiment. The session and its runs are kept, \`/${label.toLowerCase()}\` shows them`,
				);
				return;
			}
			dispatchTurn(runtime, {
				customType: "autoresearch-stall-nudge",
				content: prompt.render(autoresearchPrompts["autoresearch/stall-nudge"].text, {
					has_session: Boolean(session),
				}),
			});
			return;
		}
		runtime.stallNudges = 0;
		runtime.autoResumeArmed = false;
		runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null;
		dispatchTurn(runtime, {
			customType: "autoresearch-resume",
			content: prompt.render(autoresearchPrompts["autoresearch/resume-message"].text, {
				has_pending_run: Boolean(pendingRun),
			}),
		});
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
		const resumedBranch = runtime.pausedOnBranch !== null;
		// A turn starting is what resumes an interrupted loop, whatever it says.
		const resumedInterrupt = runtime.interrupted;
		runtime.interrupted = false;
		if (resumedBranch) {
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
		if (resumedBranch || resumedInterrupt) dashboard.update(ctx, runtime);
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
						has_swarm_setup: (runtime.pendingSwarm?.breadth ?? 1) > 1,
						swarm_breadth: runtime.pendingSwarm?.breadth ?? 1,
						swarm_attempts: runtime.pendingSwarm?.attempts ?? 1,
						swarm_certify: runtime.pendingSwarm?.certify ?? true,
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

	/**
	 * Close `session` and leave every file alone. The runtime is emptied, the
	 * mode is left, the tools detach and the model an arm switched to is
	 * restored; the logged runs stay in the store.
	 */
	async function closeSession(
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		session: SessionRow | null,
		storage: AutoresearchStorage | null,
	): Promise<{ strandedOn: string | null }> {
		if (session && storage) storage.closeSession(session.id);
		runtime.state = createExperimentState();
		runtime.goal = null;
		runtime.lastRunDuration = null;
		runtime.lastRunAsi = null;
		runtime.lastRunArtifactDir = null;
		runtime.lastRunNumber = null;
		runtime.lastRunSummary = null;
		runtime.pendingSwarm = null;
		// Same reason as `off`: a closed session leaves nothing behind, including
		// the model an arm switched to.
		const exit = await leaveArm(api, runtime);
		setMode(ctx, false, null, "clear");
		dashboard.update(ctx, runtime);
		await api.setActiveTools(activeToolsFor(api.getActiveTools(), false, effectiveBreadth(runtime)));
		return { strandedOn: exit.strandedOn };
	}

	/**
	 * Clear the session on this branch. With `resetTree` the worktree is reset
	 * to the segment baseline first, after a confirmation that states the
	 * commit and the file count; `keepHint` is the caller's own way of closing
	 * the session without touching files, for the prompts to state.
	 */
	async function handleClear(
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		opts: { resetTree: boolean; keepHint: string },
	): Promise<void> {
		// Open only what exists: a clear on a project that never ran a loop
		// must not create the store it is clearing.
		const storage = await openAutoresearchStorageIfExists(ctx.cwd);
		const branchName = await tryReadBranch(ctx.cwd);
		// Scoped to the branch: the newest open session may belong to another one,
		// and its baseline is the commit `git reset --hard` below would move this
		// worktree to. Every other caller resolves the session the same way.
		const session = storage?.getActiveSessionForBranch(branchName) ?? null;
		if (opts.resetTree && session?.baselineCommit) {
			// `git reset --hard` plus `git clean` is the one autoresearch action with
			// nothing behind it: uncommitted work in the worktree is gone, and what
			// reaches it is four letters after a slash or one Enter in the console.
			// Prompt, state the commit and the file count, and treat a decline as
			// "clear nothing".
			const dirty = await dirtyPathCount(ctx.cwd);
			if (dirty === null) {
				// Nothing is reset and the session stays open, so the baseline commit
				// this needs is still recorded when git answers again.
				ctx.ui.notify(
					`Could not read git status, so nothing was reset and the session is still open. ${opts.keepHint}`,
					"error",
				);
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Reset worktree to baseline?",
				`Resets to ${session.baselineCommit.slice(0, 12)} and deletes untracked files${
					dirty > 0 ? `, discarding uncommitted changes in ${dirty} ${dirty === 1 ? "file" : "files"}` : ""
				}. ${opts.keepHint}`,
			);
			if (!confirmed) {
				ctx.ui.notify("Clear cancelled; nothing was reset.", "info");
				return;
			}
			try {
				await git.reset(ctx.cwd, { hard: true, target: session.baselineCommit });
				await git.clean(ctx.cwd);
				// The legacy files the prompt forbids are cleared with the tree, and
				// only with it: a clear that keeps the tree leaves every file alone,
				// the harness included.
				removeLegacyArtifacts(ctx.cwd);
				ctx.ui.notify(`Reset worktree to baseline ${session.baselineCommit.slice(0, 12)}.`, "info");
			} catch (err) {
				ctx.ui.notify(`Failed to reset worktree to baseline: ${errorMessage(err)}`, "error");
			}
		} else if (opts.resetTree) {
			ctx.ui.notify("No baseline commit recorded — skipped worktree reset.", "warning");
		}

		const { strandedOn } = await closeSession(ctx, runtime, session, storage);
		ctx.ui.notify(
			strandedOn
				? `Autoresearch session cleared, but your model could not be restored. The session is still on ${strandedOn}.`
				: "Autoresearch session cleared.",
			strandedOn ? "warning" : "info",
		);
	}
};

/**
 * Files the upstream loop once kept in the worktree and the prompt now forbids.
 * `autoresearch.sh` is not among them: it is the live harness, committed on the
 * session's branch.
 */
const LEGACY_ARTIFACTS = [
	"autoresearch.md",
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
