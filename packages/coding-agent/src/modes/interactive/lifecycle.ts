import { matchesKey, planPaintGround, TERMINAL } from "@veyyon/tui";
import { APP_NAME, logger, postmortem } from "@veyyon/utils";
import chalk from "chalk";
import { SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../../session/agent-session";
import { BackgroundSessions } from "../../session/background-sessions";
import { popTerminalTitle } from "../../utils/title-generator";
import { renderSunsetField } from "../components/sun";
import type { InteractiveMode } from "../interactive-mode";
import { applyGroundPaint } from "../theme/ground-tints";
import { getCurrentThemeName, theme } from "../theme/theme";
import { RELAUNCH_MARKER } from "../tty-input-flush";

export class LifecycleManager {
	#host: InteractiveMode;
	#isShuttingDown = false;
	#frameProductionFrozen = false;
	#relaunchSpec: { argv: string[]; env?: Record<string, string | undefined> } | undefined;
	#shutdownInputGateRelease: (() => void) | undefined;
	#paintGroundWarnedThemes = new Set<string>();

	constructor(host: InteractiveMode) {
		this.#host = host;
	}

	get isFrameProductionFrozen(): boolean {
		return this.#frameProductionFrozen;
	}

	get isShuttingDown(): boolean {
		return this.#isShuttingDown;
	}

	applyPaintGround(): void {
		const plan = planPaintGround(
			this.#host.settings.get("tui.paintGround"),
			theme.getGroundHex(),
			this.#host.ui.terminal.backgroundColor,
		);
		if (plan.unhonoredAlways) {
			const name = getCurrentThemeName();
			if (name !== undefined && !this.#paintGroundWarnedThemes.has(name)) {
				this.#paintGroundWarnedThemes.add(name);
				logger.warn(
					'tui.paintGround is "always" but the active theme declares no ground color, so the terminal background is left unpainted',
					{
						theme: name,
						fix: 'Pick a theme that declares a page background, or set tui.paintGround to "auto" or "never". A custom theme can declare one via its "export.pageBg".',
					},
				);
			}
		}
		applyGroundPaint(plan, this.#host.ui.terminal);
	}

	stop(): void {
		this.freezeFrameProduction();
		if (this.#host.cleanupUnsubscribe) {
			this.#host.cleanupUnsubscribe();
			this.#host.cleanupUnsubscribe = undefined;
		}
		this.#shutdownInputGateRelease?.();
		this.#shutdownInputGateRelease = undefined;
		if (this.#host.isInitialized) {
			this.#host.ui.stop();
			this.#host.isInitialized = false;
		}
	}

	freezeFrameProduction(): void {
		if (this.#frameProductionFrozen) return;
		this.#frameProductionFrozen = true;
		this.#host.workingLoaderManager.stopLoadingAnimation(false);
		this.#host.commandDispatcher.cleanupMicAnimation();
		this.#host.workingLoaderManager.dispose();
		this.#host.todoBoardManager.cancelTodoAutoClearTimer();
		this.#host.todoBoardManager.cancelAnchoredMotionTimer();
		this.#host.eventHandlers.cancelObserverUiSyncTimer();
		this.#host.goalModeController.cancelGoalContinuation();
		this.#host.commandDispatcher.dispose();
		this.#host.extensionUiController.clearExtensionTerminalInputListeners();
		this.#host.extensionUiController.clearHookWidgets();
		for (const unsubscribe of this.#host.eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#host.eventBusUnsubscribers = [];
		this.#host.observerRegistry.dispose();
		this.#host.agentRegistryUnsubscribe?.();
		this.#host.agentRegistryUnsubscribe = undefined;
		this.#host.agentRegistrySubscriptionTarget = undefined;
		this.#host.bashForegroundUnsubscribe?.();
		this.#host.bashForegroundUnsubscribe = undefined;
		this.#host.backgroundSessionsUnsubscribe?.();
		this.#host.backgroundSessionsUnsubscribe = undefined;
		this.#host.eventController.dispose();
		this.#host.statusLine.dispose();
		if (this.#host.resizeHandler) {
			process.stdout.removeListener("resize", this.#host.resizeHandler);
			this.#host.resizeHandler = undefined;
		}
		if (this.#host.unsubscribe) {
			this.#host.unsubscribe();
			this.#host.unsubscribe = undefined;
		}
	}

	commitClosingFrame(): Promise<void> {
		if (!this.#host.isInitialized) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const previous = this.#host.ui.onFrameComposed;
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.#host.ui.onFrameComposed = previous;
			resolve();
		};
		const timer = setTimeout(finish, 250);
		this.#host.ui.onFrameComposed = () => {
			finish();
		};
		this.#host.ui.requestRender();
		return promise;
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;

		this.#shutdownInputGateRelease ??= this.#host.ui.addInputListener(data =>
			matchesKey(data, "ctrl+c") ? undefined : { consume: true },
		);

		this.#host.btwController.dispose();
		this.#host.omfgController.dispose();
		this.#host.focusController.dispose();

		this.#host.showStatus("Closing session…");

		await this.commitClosingFrame();
		this.freezeFrameProduction();

		await BackgroundSessions.global().drain();

		if (this.#host.signalTeardown) {
			await this.#host.signalTeardown();
		} else {
			await this.#host.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
		}

		await this.#host.ui.terminal.drainInput(1000);
		popTerminalTitle();
		this.stop();

		if (process.stderr.isTTY) {
			const sunset = renderSunsetField({ cols: 40, rows: 7, time: 0.6, trueColor: TERMINAL.trueColor });
			if (sunset.length > 0) {
				process.stderr.write(`\n${sunset}\n`);
			}
		}

		if (this.#relaunchSpec) {
			const spec = this.#relaunchSpec;
			this.#relaunchSpec = undefined;
			const relaunchArgv = [spec.argv[0], RELAUNCH_MARKER, ...spec.argv.slice(1)];
			const mergedEnv: Record<string, string | undefined> = { ...process.env, ...spec.env };
			const proc = Bun.spawn(relaunchArgv, {
				stdio: ["inherit", "inherit", "inherit"],
				env: mergedEnv as Record<string, string>,
			});
			await postmortem.quit(await proc.exited);
			return;
		}

		const exitMessage = `${chalk.bold(APP_NAME)} session ended`;
		console.log(theme.fg("dim", exitMessage));
		await postmortem.quit(0);
	}

	requestRelaunch(spec: { argv: string[]; env?: Record<string, string | undefined> }): void {
		this.#relaunchSpec = spec;
	}

	async checkShutdownRequested(): Promise<void> {
		if (this.#host.shutdownRequested) {
			this.#host.shutdownRequested = false;
			await this.shutdown();
		}
	}
}
