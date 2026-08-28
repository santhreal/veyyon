import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError, type AgentToolResult } from "@veyyon/agent-core";
import type { CompactionOutcome } from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import { modelsAreEqual } from "@veyyon/catalog/models";
import type { OverlayHandle } from "@veyyon/tui";
import { errorMessage, formatNumber, isEnoent, prompt } from "@veyyon/utils";
import type { ContextUsage } from "../../extensibility/extensions";
import { listLocalPlanFileUrls, resolveLocalUrlToPath } from "../../internal-urls/local-protocol";
import {
	humanizePlanTitle,
	type PlanApprovalDetails,
	resolveApprovedPlan,
	resolvePlanTitle,
} from "../../plan-mode/approved-plan";
import { DEFAULT_PLAN_FILE_URL } from "../../plan-mode/plan-file-url";
import { resolvePlanFilePath } from "../../plan-mode/plan-path";
import { planModePrompts } from "../../prompts/plan-mode/rows";
import type { ResolvedRoleModel } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "../../thinking";
import { type ResolveToolDetails, runResolveInvocation } from "../../tools/resolve";
import { ToolError } from "../../tools/tool-errors";
import { copyToClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import type { HookSelectorSlider } from "../components/hook-selector";
import { PlanReviewOverlay } from "../components/plan-review-overlay";
import type { InteractiveMode } from "../interactive-mode";

export const PLAN_KEEP_CONTEXT_OPTION_INDEX = 2;
export const PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 80;

function formatContextTokenCount(value: number): string {
	return formatNumber(Math.max(0, Math.round(value))).toLowerCase();
}

export class PlanModeController {
	#host: InteractiveMode;
	planModeEnabled = false;
	planModePaused = false;
	planModePlanFilePath: string | undefined = undefined;
	#planModeHasEntered = false;
	#planModePreviousTools: string[] | undefined;
	#planModePreviousModelState: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	#planReviewCancel: (() => void) | undefined;
	#planReviewOverlayHandle: OverlayHandle | undefined;
	#planReviewOverlay: PlanReviewOverlay | undefined;

	constructor(host: InteractiveMode) {
		this.#host = host;
	}

	get planModeHasEntered(): boolean {
		return this.#planModeHasEntered;
	}

	set planModeHasEntered(val: boolean) {
		this.#planModeHasEntered = val;
	}

	get planModePreviousTools(): string[] | undefined {
		return this.#planModePreviousTools;
	}

	get planModePreviousModelState(): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
		return this.#planModePreviousModelState;
	}

	async getPlanFilePath(): Promise<string> {
		return this.#host.session.getPlanReferencePath() || DEFAULT_PLAN_FILE_URL;
	}

	resolvePlanFilePath(planFilePath: string): string {
		return resolvePlanFilePath(planFilePath, {
			localProtocol: {
				getArtifactsDir: () => this.#host.sessionManager.getArtifactsDir(),
				getSessionId: () => this.#host.sessionManager.getSessionId(),
			},
			cwd: this.#host.sessionManager.getCwd(),
		});
	}

	updatePlanModeStatus(): void {
		const status =
			this.planModeEnabled || this.planModePaused
				? {
						enabled: this.planModeEnabled,
						paused: this.planModePaused,
					}
				: undefined;
		this.#host.statusLine.setPlanModeStatus(status);
		this.#host.updateEditorBorderColor();
		this.#host.ui.requestRender();
	}

	async applyPlanModeModel(): Promise<void> {
		const resolved = this.#host.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;

		const currentModel = this.#host.session.model;
		const sameModel = modelsAreEqual(currentModel, resolved.model);
		const planThinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;

		this.#planModePreviousModelState = currentModel
			? { model: currentModel, thinkingLevel: this.#host.session.configuredThinkingLevel() }
			: undefined;

		if (!sameModel) {
			if (this.#host.session.isStreaming) {
				this.#pendingModelSwitch = { model: resolved.model, thinkingLevel: planThinkingLevel };
				return;
			}
			try {
				await this.#host.session.setModelTemporary(resolved.model, planThinkingLevel);
			} catch (error) {
				this.#host.showWarning(`Failed to switch to plan model for plan mode: ${errorMessage(error)}`);
			}
		} else if (planThinkingLevel !== undefined) {
			this.#host.session.setThinkingLevel(planThinkingLevel);
		}
	}

	async flushPendingModelSwitch(): Promise<void> {
		if (!this.#pendingModelSwitch) return;
		const next = this.#pendingModelSwitch;
		this.#pendingModelSwitch = undefined;
		await this.#host.session.setModelTemporary(next.model, next.thinkingLevel);
	}

	async restorePlanPreviousModel(prev: { model: Model; thinkingLevel?: ConfiguredThinkingLevel }): Promise<void> {
		if (modelsAreEqual(this.#host.session.model, prev.model)) {
			this.#host.session.setThinkingLevel(prev.thinkingLevel);
		} else if (this.#host.session.isStreaming) {
			this.#pendingModelSwitch = { model: prev.model, thinkingLevel: prev.thinkingLevel };
		} else {
			await this.#host.session.setModelTemporary(prev.model, prev.thinkingLevel);
		}
	}

	async applyDeferredPlanModelTransition(
		outcome: CompactionOutcome | undefined,
		executionModel: ResolvedRoleModel | undefined,
	): Promise<void> {
		const deferredPrev = this.#planModePreviousModelState;
		if (deferredPrev === undefined || outcome === "failed") return;
		this.#planModePreviousModelState = undefined;
		if (executionModel) {
			await this.applyPlanExecutionModel(executionModel);
		} else {
			await this.restorePlanPreviousModel(deferredPrev);
		}
	}

	async enterPlanMode(options?: { planFilePath?: string; workflow?: "parallel" | "iterative" }): Promise<void> {
		if (this.planModeEnabled) {
			return;
		}
		if (this.#host.goalModeEnabled || this.#host.goalModePaused) {
			this.#host.showWarning("Exit goal mode first.");
			return;
		}
		if (this.#host.vibeModeEnabled) {
			this.#host.showWarning("Exit vibe mode first.");
			return;
		}

		this.planModePaused = false;

		const planFilePath = options?.planFilePath ?? (await this.getPlanFilePath());
		const previousTools = this.#host.session.getActiveToolNames();
		const planAugmentations = ["resolve"];
		if (this.#host.session.hasBuiltInTool("write")) {
			planAugmentations.push("write");
		}
		const uniquePlanTools = Array.from(
			new Set(previousTools.filter(name => name !== "goal").concat(planAugmentations)),
		);

		this.#planModePreviousTools = previousTools;
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;
		this.#host.lastAssistantUsage = undefined;

		await this.#host.session.setActiveToolsByName(uniquePlanTools);
		this.#host.session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#planModeHasEntered,
		});
		this.#host.session.setStandingResolveHandler?.(input => this.runPlanApprovalResolve(input));
		if (this.#host.session.isStreaming) {
			await this.#host.session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#planModeHasEntered = true;
		await this.applyPlanModeModel();
		this.updatePlanModeStatus();
		this.#host.sessionManager.appendModeChange("plan", { planFilePath });
		this.#host.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	runPlanApprovalResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				const state = this.#host.session.getPlanModeState?.();
				if (!state?.enabled) {
					throw new ToolError("Plan mode is not active.");
				}
				const { planFilePath, title } = await resolveApprovedPlan({
					suppliedTitle: extra?.title,
					statePlanFilePath: state.planFilePath,
					readPlan: url => this.readPlanFile(url),
					listPlanFiles: () => this.listLocalPlanFiles(),
				});
				const details: PlanApprovalDetails = {
					planFilePath,
					title,
					planExists: true,
				};
				return {
					content: [{ type: "text" as const, text: "Plan ready for approval." }],
					details,
				};
			},
		});
	}

	async exitPlanMode(options?: { silent?: boolean; paused?: boolean; deferModelRestore?: boolean }): Promise<void> {
		if (!this.planModeEnabled) {
			return;
		}

		const previousTools = this.#planModePreviousTools;
		if (previousTools && previousTools.length > 0) {
			await this.#host.session.setActiveToolsByName(previousTools);
		}
		if (this.#planModePreviousModelState) {
			if (!options?.deferModelRestore) {
				await this.restorePlanPreviousModel(this.#planModePreviousModelState);
			}
			if (!options?.deferModelRestore) {
				this.#planModePreviousModelState = undefined;
			}
		}

		this.planModeEnabled = false;
		this.planModePaused = options?.paused ?? false;
		this.#planModePreviousTools = undefined;
		this.#host.session.setPlanModeState(undefined);
		this.#host.session.setStandingResolveHandler?.(null);
		this.updatePlanModeStatus();
		if (!options?.silent) {
			this.#host.showStatus(options?.paused ? "Plan mode paused." : "Plan mode disabled.");
		}
	}

	async readPlanFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.resolvePlanFilePath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	async hasPlanModeDraftContent(planFilePath: string): Promise<boolean> {
		const candidates = new Set<string>([planFilePath, ...(await this.listLocalPlanFiles())]);
		for (const candidate of candidates) {
			const content = await this.readPlanFile(candidate);
			if (content !== null && content.trim().length > 0) return true;
		}
		return false;
	}

	async listLocalPlanFiles(): Promise<string[]> {
		return listLocalPlanFileUrls(this.resolvePlanFilePath("local://"));
	}

	showPlanReview(
		planContent: string,
		title: string,
		options: string[],
		dialogOptions?: {
			helpText?: string;
			disabledIndices?: number[];
			onExternalEditor?: () => void;
			onPlanEdited?: (content: string) => void;
			onFeedbackChange?: (feedback: string) => void;
			initialIndex?: number;
		},
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		this.hidePlanReview();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		const finish = (choice: string | undefined): void => {
			if (settled) return;
			settled = true;
			this.hidePlanReview();
			this.#host.ui.requestRender();
			resolve(choice);
		};
		this.#planReviewCancel = () => finish(undefined);
		const overlay = new PlanReviewOverlay(
			planContent,
			{
				promptTitle: title,
				options,
				disabledIndices: dialogOptions?.disabledIndices,
				helpText: dialogOptions?.helpText,
				initialIndex: dialogOptions?.initialIndex,
				slider: extra?.slider,
				externalEditorLabel: this.#host.keybindings.getDisplayString("app.editor.external") || undefined,
				requestRender: () => this.#host.ui.requestRender(),
			},
			{
				onPick: choice => finish(choice),
				onCancel: () => finish(undefined),
				onCopyPlan: content => void this.copyPlanToClipboard(content),
				onExternalEditor: dialogOptions?.onExternalEditor,
				onAnnotationExternalEditor: (draft, commit) => void this.openPlanAnnotationInExternalEditor(draft, commit),
				onPlanEdited: dialogOptions?.onPlanEdited,
				onFeedbackChange: dialogOptions?.onFeedbackChange,
			},
		);
		this.#planReviewOverlay = overlay;
		this.#planReviewOverlayHandle = this.#host.ui.showOverlay(overlay, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.#host.ui.setFocus(overlay);
		this.#host.ui.requestRender();
		return promise;
	}

	hidePlanReview(): void {
		this.#planReviewCancel = undefined;
		this.#planReviewOverlayHandle?.hide();
		this.#planReviewOverlayHandle = undefined;
		this.#planReviewOverlay = undefined;
	}

	dismissPlanReview(): void {
		const cancel = this.#planReviewCancel;
		this.#planReviewCancel = undefined;
		cancel?.();
		this.hidePlanReview();
	}

	getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	getPlanApprovalContextUsage(): ContextUsage | undefined {
		const executionModel = this.#planModePreviousModelState?.model ?? this.#host.session.model;
		const contextWindow = executionModel?.contextWindow;
		if (typeof contextWindow === "number") {
			return this.#host.session.getContextUsage({ contextWindow });
		}
		return this.#host.session.getContextUsage();
	}

	formatKeepContextLabel(contextUsage: ContextUsage | undefined): string {
		if (!contextUsage) {
			return "Approve and keep context";
		}
		const tokens = formatContextTokenCount(contextUsage.tokens);
		const contextWindow = formatContextTokenCount(contextUsage.contextWindow);
		return `Approve and keep context (~${tokens} / ${contextWindow})`;
	}

	isKeepContextDisabled(contextUsage: ContextUsage | undefined): boolean {
		return contextUsage !== undefined && contextUsage.percent > PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT;
	}

	async copyPlanToClipboard(content: string): Promise<void> {
		try {
			await copyToClipboard(content);
			this.#host.showStatus("Copied plan to clipboard");
		} catch (error) {
			this.#host.showWarning(`Failed to copy plan to clipboard: ${errorMessage(error)}`);
		}
	}

	async openPlanInExternalEditor(planFilePath: string): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.#host.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const resolvedPath = this.resolvePlanFilePath(planFilePath);
		let currentText: string;
		try {
			currentText = await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				this.#host.showError(`Plan file not found at ${planFilePath}`);
				return;
			}
			this.#host.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
			return;
		}

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.openEditorTerminalHandle();
			this.#host.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, {
				extension: path.extname(resolvedPath) || ".md",
				stdio,
				trimTrailingNewline: false,
			});
			if (result !== null) {
				await Bun.write(resolvedPath, result);
				this.#planReviewOverlay?.setPlanContent(result);
				this.#host.showStatus("Plan updated in external editor.");
			}
		} catch (error) {
			this.#host.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}
			this.#host.ui.start();
			this.#host.ui.requestRender(true);
		}
	}

	async openPlanAnnotationInExternalEditor(draft: string, commit: (text: string | null) => void): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.#host.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.openEditorTerminalHandle();
			this.#host.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, draft, { extension: ".md", stdio });
			if (result !== null) {
				commit(result);
			}
		} catch (error) {
			this.#host.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}
			this.#host.ui.start();
			this.#host.ui.requestRender(true);
		}
	}

	async applyPlanExecutionModel(entry: ResolvedRoleModel | undefined): Promise<void> {
		if (!entry) return;
		try {
			await this.#host.session.applyRoleModel(entry);
			this.#host.statusLine.invalidate();
			this.#host.updateEditorBorderColor();
			this.#host.showStatus(`Continuing with ${entry.role}: ${entry.model.name || entry.model.id}`);
		} catch (error) {
			this.#host.showWarning(`Could not switch to the ${entry.role} model: ${errorMessage(error)}`);
		}
	}

	resolveLocalRoot(): string {
		return resolveLocalUrlToPath("local://", {
			getArtifactsDir: () => this.#host.sessionManager.getArtifactsDir(),
			getSessionId: () => this.#host.sessionManager.getSessionId(),
		});
	}

	async copyLocalArtifactsForFreshSession(sourceRoot: string, destinationRoot: string): Promise<void> {
		if (sourceRoot === destinationRoot) return;

		let sourceRootStat: { isDirectory(): boolean };
		try {
			sourceRootStat = await fs.lstat(sourceRoot);
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}

		if (!sourceRootStat.isDirectory()) return;

		await fs.mkdir(destinationRoot, { recursive: true });
		await this.copyLocalArtifactEntries(sourceRoot, destinationRoot);
	}

	async copyLocalArtifactEntries(sourceDir: string, destinationDir: string): Promise<void> {
		const entries = await fs.readdir(sourceDir, { withFileTypes: true });
		for (const entry of entries) {
			const sourcePath = path.join(sourceDir, entry.name);
			const destinationPath = path.join(destinationDir, entry.name);

			if (entry.isDirectory()) {
				await fs.mkdir(destinationPath, { recursive: true });
				await this.copyLocalArtifactEntries(sourcePath, destinationPath);
				continue;
			}

			if (entry.isFile()) {
				await fs.mkdir(path.dirname(destinationPath), { recursive: true });
				await fs.copyFile(sourcePath, destinationPath);
			}
		}
	}

	async approvePlan(
		planContent: string,
		options: {
			planFilePath: string;
			title: string;
			preserveContext?: boolean;
			compactBeforeExecute?: boolean;
			executionModel?: ResolvedRoleModel;
		},
	): Promise<void> {
		const previousTools = this.#planModePreviousTools ?? this.#host.session.getActiveToolNames();

		if (options.compactBeforeExecute) {
			this.#host.session.markPlanInternalAbortPending();
		}
		let compactOutcome: CompactionOutcome | undefined;
		try {
			await this.exitPlanMode({
				silent: true,
				paused: false,
				deferModelRestore: options.compactBeforeExecute === true,
			});

			if (!options.preserveContext) {
				const oldLocalRoot = this.resolveLocalRoot();
				await this.#host.handleClearCommand();
				const newLocalRoot = this.resolveLocalRoot();
				await this.copyLocalArtifactsForFreshSession(oldLocalRoot, newLocalRoot);
				const newLocalPath = resolveLocalUrlToPath(options.planFilePath, {
					getArtifactsDir: () => this.#host.sessionManager.getArtifactsDir(),
					getSessionId: () => this.#host.sessionManager.getSessionId(),
				});
				await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
				await fs.writeFile(newLocalPath, planContent);
			} else if (options.compactBeforeExecute) {
				const compactionPrompt = prompt.render(planModePrompts["plan-mode/compact-instructions"].text, {
					planFilePath: options.planFilePath,
				});
				this.#host.session.setPlanReferencePath(options.planFilePath);
				compactOutcome = await this.#host.handleCompactCommand(
					undefined,
					undefined,
					outcome => this.applyDeferredPlanModelTransition(outcome, options.executionModel),
					compactionPrompt,
				);
			}
		} finally {
			this.#host.session.clearPlanInternalAbortPending();
		}

		const executionTools = previousTools.includes("read") ? previousTools : previousTools.concat(["read"]);
		await this.#host.session.setActiveToolsByName(executionTools);
		this.#host.session.setPlanReferencePath(options.planFilePath);

		if (options.compactBeforeExecute) {
			await this.applyDeferredPlanModelTransition(compactOutcome, options.executionModel);
		} else {
			await this.applyPlanExecutionModel(options.executionModel);
		}

		if (compactOutcome === "cancelled") {
			this.#host.showWarning(
				"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
			);
			return;
		}

		const seededName = humanizePlanTitle(options.title);
		if (seededName && !this.#host.sessionManager.getSessionName()) {
			await this.#host.sessionManager.setSessionName(seededName, "auto");
		}

		this.#host.session.markPlanReferenceSent();
		const planModePrompt = prompt.render(planModePrompts["plan-mode/approved"].text, {
			planFilePath: options.planFilePath,
			contextPreserved: options.preserveContext === true,
		});
		if (this.#host.session.isStreaming) {
			await this.#host.session.followUp(planModePrompt, undefined, { synthetic: true });
			return;
		}
		try {
			await this.#host.session.prompt(planModePrompt, { synthetic: true });
		} catch (error) {
			if (!(error instanceof AgentBusyError)) throw error;
			await this.#host.session.followUp(planModePrompt, undefined, { synthetic: true });
		}
	}

	async abortPlanApprovalTurnSilently(): Promise<void> {
		this.#host.session.markPlanInternalAbortPending();
		try {
			await this.#host.session.abort({ goalReason: "internal" });
		} finally {
			this.#host.session.clearPlanInternalAbortPending();
		}
	}

	async handlePlanModeCommand(initialPrompt?: string): Promise<void> {
		if (this.#host.goalModeEnabled || this.#host.goalModePaused) {
			this.#host.showWarning("Exit goal mode first.");
			return;
		}
		if (this.#host.vibeModeEnabled) {
			this.#host.showWarning("Exit vibe mode first.");
			return;
		}
		if (this.planModeEnabled) {
			const planFilePath = this.planModePlanFilePath ?? (await this.getPlanFilePath());
			if (await this.hasPlanModeDraftContent(planFilePath)) {
				const confirmed = await this.#host.showHookConfirm(
					"Exit plan mode?",
					"This exits plan mode without approving a plan.",
				);
				if (!confirmed) return;
			}
			await this.exitPlanMode({ paused: true });
			return;
		}
		if (this.planModePaused && !initialPrompt) {
			this.planModePaused = false;
			this.#planModeHasEntered = false;
			this.updatePlanModeStatus();
			this.#host.sessionManager.appendModeChange("none");
			this.#host.showStatus("Plan mode disabled.");
			return;
		}
		if (!this.#host.session.settings.get("plan.enabled")) {
			this.#host.showWarning("Plan mode is disabled. Enable it in settings (plan.enabled).");
			return;
		}
		await this.enterPlanMode();
		if (initialPrompt && this.#host.onInputCallback) {
			this.#host.onInputCallback(this.#host.startPendingSubmission({ text: initialPrompt }));
		}
	}

	async openPlanReview(): Promise<void> {
		if (!this.planModeEnabled) {
			this.#host.showWarning("Plan mode is not active.");
			return;
		}
		const noPlan = "No plan to review yet — write one to a local://<slug>-plan.md file first.";
		const [planFilePath] = await this.listLocalPlanFiles();
		if (!planFilePath) {
			this.#host.showWarning(noPlan);
			return;
		}
		const planContent = await this.readPlanFile(planFilePath);
		if (planContent === null) {
			this.#host.showWarning(noPlan);
			return;
		}
		const { title } = resolvePlanTitle({ planContent, planFilePath });
		await this.handlePlanApproval({ planFilePath, title, planExists: true });
	}

	async handlePlanApproval(details: PlanApprovalDetails): Promise<void> {
		if (!this.planModeEnabled) {
			this.#host.showWarning("Plan mode is not active.");
			return;
		}

		await this.abortPlanApprovalTurnSilently();

		const planFilePath = details.planFilePath || this.planModePlanFilePath || (await this.getPlanFilePath());
		this.planModePlanFilePath = planFilePath;
		const planContent = await this.readPlanFile(planFilePath);
		if (!planContent) {
			this.#host.showError(`Plan file not found at ${planFilePath}`);
			return;
		}

		const contextUsage = this.getPlanApprovalContextUsage();
		const keepContextLabel = this.formatKeepContextLabel(contextUsage);
		const keepContextDisabled = this.isKeepContextDisabled(contextUsage);

		const roleOrder = [
			"default",
			...this.#host.session.settings.get("cycleOrder").filter(role => role !== "default"),
		];
		const cycle = this.#host.session.getRoleModelCycle(roleOrder);
		const defaultTierIndex = cycle ? cycle.models.findIndex(entry => entry.role === "default") : -1;
		const startTierIndex = defaultTierIndex >= 0 ? defaultTierIndex : (cycle?.currentIndex ?? 0);
		let selectedTierIndex = startTierIndex;
		const slider: HookSelectorSlider | undefined =
			cycle && cycle.models.length > 1
				? {
						caption: "continue with",
						index: startTierIndex,
						segments: cycle.models.map(entry => ({
							label: entry.role,
							detail: entry.model.name || entry.model.id,
						})),
						onChange: index => {
							selectedTierIndex = index;
						},
					}
				: undefined;
		const helpText = "esc cancel";
		let editedContent: string | undefined;
		let feedback = "";

		const choice = await this.showPlanReview(
			planContent,
			"Plan mode - next step",
			["Approve and execute", "Approve and compact context", keepContextLabel, "Refine plan"],
			{
				helpText,
				onExternalEditor: () => void this.openPlanInExternalEditor(planFilePath),
				onPlanEdited: content => {
					editedContent = content;
					void Bun.write(this.resolvePlanFilePath(planFilePath), content);
				},
				onFeedbackChange: value => {
					feedback = value;
				},
				disabledIndices: keepContextDisabled ? [PLAN_KEEP_CONTEXT_OPTION_INDEX] : undefined,
			},
			{ slider },
		);

		if (choice === "Approve and execute" || choice === "Approve and compact context" || choice === keepContextLabel) {
			try {
				const latestPlanContent = editedContent ?? (await this.readPlanFile(planFilePath));
				if (editedContent !== undefined) {
					await Bun.write(this.resolvePlanFilePath(planFilePath), editedContent);
				}
				if (!latestPlanContent) {
					this.#host.showError(`Plan file not found at ${planFilePath}`);
					return;
				}
				const restoredState = this.#planModePreviousModelState;
				const restoredIndex =
					cycle && restoredState
						? cycle.models.findIndex(entry => {
								if (!modelsAreEqual(entry.model, restoredState.model)) return false;
								if (!entry.explicitThinkingLevel) return true;
								return entry.thinkingLevel === restoredState.thinkingLevel;
							})
						: -1;
				const executionModel =
					slider && cycle && selectedTierIndex !== restoredIndex ? cycle.models[selectedTierIndex] : undefined;
				await this.approvePlan(latestPlanContent, {
					planFilePath,
					title: details.title,
					preserveContext: choice !== "Approve and execute",
					compactBeforeExecute: choice === "Approve and compact context",
					executionModel,
				});
			} catch (error) {
				this.#host.showError(`Failed to finalize approved plan: ${errorMessage(error)}`);
			}
			return;
		}

		if (choice === "Refine plan") {
			const refinement = feedback.trim();
			try {
				if (refinement) {
					if (this.#host.onInputCallback) {
						this.#host.onInputCallback(this.#host.startPendingSubmission({ text: feedback }));
					} else {
						await this.#host.session.prompt(feedback);
					}
				} else {
					this.#host.showStatus("Refine plan: enter a follow-up prompt.");
				}
			} catch (error) {
				this.#host.showError(`Failed to refine plan: ${errorMessage(error)}`);
			}
			return;
		}
	}
}
