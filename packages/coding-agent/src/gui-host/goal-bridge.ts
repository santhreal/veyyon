import type * as net from "node:net";
import { errorMessage, logger } from "@veyyon/utils";
import { GoalDriver, type GoalDriverPort } from "../goals/driver";
import type { AgentSession } from "../session/agent-session";
import { writeFrame } from "./frames";
import { goalSection } from "./goal-view";
import { type ClientSessionState, executePromptTurn } from "./turns";
import type { SnapshotSection } from "./wire";

/**
 * The desktop's GoalDriverPort implementation. Drives autonomous continuation turns,
 * observes the session's blocking modes, and broadcasts Goal snapshot section updates.
 */
export class DesktopGoalBridge implements GoalDriverPort {
	readonly session: AgentSession;
	readonly clientState: ClientSessionState;
	readonly socket?: net.Socket;
	driver?: GoalDriver;
	stoodDown: string | null = null;
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

	setDriver(driver: GoalDriver): void {
		this.driver = driver;
	}

	/** Another mode holds the session, so the goal must neither activate nor drive. */
	blockingMode(): "plan" | "vibe" | "loop" | undefined {
		if (this.session.getPlanModeState()?.enabled) return "plan";
		if (this.session.getVibeModeState()?.enabled) return "vibe";
		if (this.clientState.loopDriver?.enabled) return "loop";
		return undefined;
	}

	/** The operator has unsent input in this host's composer. */
	hasUnsentInput(): boolean {
		// The window's composer draft is held client-side in the GPUI process; the host cannot see it.
		return false;
	}

	/** Mid-turn, compacting, or draining post-turn maintenance. */
	isAutoSubmitBlocked(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.session.hasPostPromptWork;
	}

	/** A submission is queued and has not started. */
	hasPendingSubmission(): boolean {
		return this.session.queuedMessageCount > 0 || this.clientState.activeTurnPromise !== undefined;
	}

	/** That queued submission is a visible user turn rather than a synthetic one. */
	hasPendingVisibleUserSubmission(): boolean {
		const queued = this.session.getQueuedMessages();
		return queued.steering.length > 0 || queued.followUp.length > 0;
	}

	/** This host can open a turn at all right now. */
	canSubmit(): boolean {
		return !this.clientState.closed && !this.session.isStreaming && !this.session.isCompacting;
	}

	/** Open the goal's continuation turn, hidden from the transcript. */
	submitContinuation(prompt: string): void {
		// The goal is driving again, so whatever it last stood down over is no longer the state
		// the card should be stating.
		this.stoodDown = null;
		void executePromptTurn(this.session, this.clientState, prompt, [], undefined, {
			customType: "goal-continuation",
			display: false,
		}).catch(error => {
			logger.warn("Goal continuation turn rejected", {
				error: errorMessage(error),
			});
		});
	}

	/** Say something to the operator in this host's register. */
	warn(message: string): void {
		this.stoodDown = message;
		logger.warn(message);
	}

	/**
	 * State an outcome of the goal to the operator in this host's register. The window draws the
	 * goal card from the Goal snapshot section, which the repaint below carries, so the line is
	 * recorded rather than pushed: the protocol has no notice frame.
	 */
	status(message: string): void {
		logger.info(message);
		this.changed();
	}

	/** The goal's flags or record moved: repaint whatever states them. */
	changed(): void {
		const section = goalSection(this.session, this.driver, this.stoodDown);
		if (this.#broadcast) {
			this.#broadcast(section);
		} else if (this.socket && !this.socket.destroyed) {
			writeFrame(this.socket, { Snapshot: section });
		}
	}
}

/**
 * The bridge and driver this client drives the session's goal through, made once per session and
 * reused after.
 *
 * A session resumed with a goal on it is restored by `GoalDriver.restoreFromSession`, the same
 * call the terminal makes: it reads the mode entry, asks the runtime to resume the goal, sets the
 * driving flags and installs the `goal` tool. Reading the stored status and setting the flags here
 * would be a second restore, and one that leaves the agent without the tool its goal needs.
 */
export async function attachGoalBridge(
	session: AgentSession,
	state: ClientSessionState,
	socket?: net.Socket,
	broadcast?: (section: SnapshotSection) => void,
): Promise<GoalDriver> {
	if (state.goalDriver && state.goalBridge?.session === session) {
		return state.goalDriver;
	}
	state.goalDriver?.unsubscribeFromSession();
	const bridge = new DesktopGoalBridge(session, state, socket, broadcast);
	const driver = new GoalDriver(bridge);
	bridge.setDriver(driver);
	driver.subscribeToSession();
	state.goalBridge = bridge;
	state.goalDriver = driver;
	await driver.restoreFromSession(session.sessionManager.buildSessionContext());
	return driver;
}
