import type * as net from "node:net";
import { errorMessage, logger } from "@veyyon/utils";
import { LoopDriver, type LoopDriverPort } from "../loop/driver";
import type { AgentSession } from "../session/agent-session";
import { writeFrame } from "./frames";
import { sessionHeaderToView } from "./session-bridge";
import { type ClientSessionState, executePromptTurn } from "./turns";
import type { SnapshotSection } from "./wire";

/**
 * The desktop's LoopDriverPort implementation. Drives autonomous loop iterations,
 * observes the session's blocking modes, and broadcasts ActiveSession snapshot section updates.
 */
export class DesktopLoopBridge implements LoopDriverPort {
	readonly session: AgentSession;
	readonly clientState: ClientSessionState;
	readonly socket?: net.Socket;
	driver?: LoopDriver;
	readonly #broadcast?: (section: SnapshotSection) => void;

	constructor(
		session: AgentSession,
		clientState: ClientSessionState,
		socket?: net.Socket,
		broadcast?: (section: SnapshotSection) => void,
	) {
		this.session = session;
		this.clientState = clientState;
		this.socket = socket;
		this.#broadcast = broadcast;
	}

	setDriver(driver: LoopDriver): void {
		this.driver = driver;
	}

	/** Another mode holds the session, so the loop must neither activate nor drive. */
	blockingMode(): "plan" | "vibe" | "goal" | undefined {
		if (this.session.getPlanModeState()?.enabled) return "plan";
		if (this.session.getVibeModeState()?.enabled) return "vibe";
		if (this.clientState.goalDriver?.active) return "goal";
		return undefined;
	}

	/** Mid-turn, compacting, or draining post-turn maintenance. */
	isAutoSubmitBlocked(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.session.hasPostPromptWork;
	}

	/** This host can open a turn at all right now. */
	canSubmit(): boolean {
		return !this.clientState.closed && !this.session.isStreaming && !this.session.isCompacting;
	}

	/** Open the next loop iteration turn. */
	submitPrompt(prompt: string): void {
		void executePromptTurn(this.session, this.clientState, prompt).catch(error => {
			logger.warn("Loop prompt submission rejected", {
				error: errorMessage(error),
			});
		});
	}

	/** Say something to the operator in this host's register. */
	warn(message: string): void {
		logger.warn(message);
	}

	/** The loop's flags or record moved: repaint whatever states them. */
	changed(): void {
		const sm = this.session.sessionManager;
		if (this.driver && !this.driver.enabled) {
			const entries = sm.getEntries();
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (entry?.type === "mode_change") {
					if (entry.mode === "loop") {
						sm.appendModeChange("none");
					}
					break;
				}
			}
		}
		const view = sessionHeaderToView(sm.getHeader(), sm.getEntries());
		this.clientState.revision += 1;
		const section: SnapshotSection = {
			ActiveSession: {
				revision: this.clientState.revision,
				value: view,
			},
		};
		if (this.#broadcast) {
			this.#broadcast(section);
		} else if (this.socket && !this.socket.destroyed) {
			writeFrame(this.socket, { Snapshot: section });
		}
	}
}

/**
 * Attach the loop bridge and driver to a session, reused across subsequent requests.
 */
export async function attachLoopBridge(
	session: AgentSession,
	state: ClientSessionState,
	socket?: net.Socket,
	broadcast?: (section: SnapshotSection) => void,
): Promise<LoopDriver> {
	if (state.loopDriver && state.loopBridge?.session === session) {
		return state.loopDriver;
	}
	state.loopDriver?.unsubscribeFromSession();
	const bridge = new DesktopLoopBridge(session, state, socket, broadcast);
	const driver = new LoopDriver(bridge);
	bridge.setDriver(driver);
	driver.subscribeToSession();
	state.loopBridge = bridge;
	state.loopDriver = driver;
	await driver.restoreFromSession(session.sessionManager.buildSessionContext());
	return driver;
}

/**
 * Exit loop mode for the session, recording a mode change to "none" if it was enabled.
 */
export async function exitLoopMode(session: AgentSession, state: ClientSessionState): Promise<boolean> {
	if (!state.loopDriver?.enabled) {
		return false;
	}
	state.loopDriver.stop();
	session.sessionManager.appendModeChange("none");
	return true;
}
