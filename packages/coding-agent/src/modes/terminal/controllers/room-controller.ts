/**
 * RoomController - the sideways axis of one terminal: several driving agents,
 * each with its own conversation and its own spawns, side by side, and the
 * operator moving between them.
 *
 * The runtime already existed: `AgentRegistry` holds many `kind: "main"` rows
 * per process, `attachMainSession` re-points the screen at any live session
 * and hands the displayed one to `BackgroundSessions`, and the irc bus
 * delivers by registry id. What this adds is the room (`AgentRef.room`), the
 * command that opens a peer, the strip that lists them and the switch.
 *
 * A switch is a full attach, not a focus. `SessionFocusController` proxies the
 * view onto a spawn while `ctx.session` stays the driver, and the editor is a
 * plain chat box for it: no slash commands, no model cycling. A peer IS a
 * driver, so after a switch it is `ctx.session` outright and every command,
 * keybinding and status surface works on it as on the first session.
 *
 * One cwd for the room. `getProjectDir()` is process-global at several sites,
 * so a peer opens in the displayed session's cwd; a peer that later moved its
 * own cwd is re-rooted on switch the way `/resume` re-roots.
 */

import { Text, type ViewportSnapshot } from "@veyyon/tui";
import { normalizePathForComparison } from "@veyyon/utils";
import { matchesKey } from "@veyyon/utils/keys";
import { AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../../registry/agent-registry";
import type { AgentSession } from "../../../session/agent-session";
import { BackgroundSessions } from "../../../session/background-sessions";
import { setSessionTerminalTitle } from "../../../utils/title-generator";
import { type RoomStripMember, renderRoomStripLine, roomMemberLabel } from "../components/dashboard/room-strip";
import type { InteractiveModeContext } from "../types";

export type RoomControllerContext = Pick<
	InteractiveModeContext,
	| "applyCwdChange"
	| "attachMainSession"
	| "clearTransientSessionUi"
	| "createNextSession"
	| "focusedAgentId"
	| "reloadTodos"
	| "renderInitialMessages"
	| "resetObserverRegistry"
	| "roomContainer"
	| "session"
	| "sessionManager"
	| "showError"
	| "showStatus"
	| "statusLine"
	| "ui"
	| "unfocusSession"
	| "updateEditorBorderColor"
>;

/** Horizontal padding of the anchored strip, matching the other anchored blocks. */
const STRIP_PADDING_X = 1;

export class RoomController {
	/** Id under the strip's cursor; undefined while the strip is closed. */
	#selectedId: string | undefined;
	#registryUnsubscribe: (() => void) | undefined;
	#inputUnsubscribe: (() => void) | undefined;
	/** Serializes switches: a second switch while one is attaching is dropped. */
	#switching = false;

	constructor(
		private readonly ctx: RoomControllerContext,
		private readonly registry: AgentRegistry = AgentRegistry.global(),
	) {}

	/** Subscribe to the registry and the input stream. Idempotent. */
	install(): void {
		this.#registryUnsubscribe ??= this.registry.onChange(event => this.#onRegistryEvent(event));
		this.#inputUnsubscribe ??= this.ctx.ui.addInputListener(data => this.#onInput(data));
		this.#syncPeerCount();
	}

	dispose(): void {
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		this.#inputUnsubscribe?.();
		this.#inputUnsubscribe = undefined;
		this.#selectedId = undefined;
	}

	get isOpen(): boolean {
		return this.#selectedId !== undefined;
	}

	/** Registry id of the driving agent on screen. */
	get ownId(): string {
		return this.ctx.session.getAgentId() ?? MAIN_AGENT_ID;
	}

	/** Every driving agent in the room including the one on screen, oldest first. */
	members(): RoomStripMember[] {
		return this.registry.roomMembers(this.ownId).map(ref => ({
			ref,
			title: ref.session?.sessionManager.getSessionName(),
		}));
	}

	/** The other driving agents in the room. */
	peers(): RoomStripMember[] {
		return this.members().filter(member => member.ref.id !== this.ownId);
	}

	/**
	 * Open a conversation beside the one on screen and attach the screen to it.
	 * The displayed conversation keeps running: it is handed to the background
	 * keeper exactly as `/new` hands over a streaming turn, and it stays a live
	 * registry row this controller can switch back to.
	 */
	async openPeer(): Promise<void> {
		const createNextSession = this.ctx.createNextSession;
		if (!createNextSession) {
			this.ctx.showError("This host cannot open a second conversation.");
			return;
		}
		if (this.#switching) return;
		if (this.ctx.focusedAgentId) await this.ctx.unfocusSession();
		const room = this.registry.ensureRoom(this.ownId);
		if (room === undefined) {
			this.ctx.showError("The current session is not registered as a driving agent, so it cannot open a room.");
			return;
		}
		this.#switching = true;
		try {
			// A new peer joins at the end of the room, so it enters from the right.
			const from = this.ctx.ui.captureViewport();
			const next = await createNextSession({ room });
			await this.#attach(next, from, "left");
			this.ctx.showStatus(
				`Opened a peer conversation beside ${this.#labelOf(this.registry.get(this.ownId)?.id)} — →→ switches between them`,
			);
		} catch (error) {
			this.ctx.showError(
				`Could not open a peer conversation: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.#switching = false;
		}
	}

	/**
	 * Attach the screen to peer `id`. Refuses a stranger: only a driving agent
	 * the registry lists as a peer of this room (which excludes a killed one),
	 * and only one with a live session, is a valid target.
	 */
	async switchTo(id: string): Promise<void> {
		if (id === this.ownId) return;
		const target = this.registry.peers(this.ownId).find(ref => ref.id === id);
		if (!target) {
			this.ctx.showError(`"${id}" is not a peer of this conversation. Run /room to list the room.`);
			return;
		}
		if (!target.session) {
			this.ctx.showError(`Peer "${id}" has no live session to switch to.`);
			return;
		}
		if (this.#switching) return;
		this.#switching = true;
		try {
			if (this.ctx.focusedAgentId) await this.ctx.unfocusSession();
			const label = this.#labelOf(id);
			const members = this.members();
			const direction =
				members.findIndex(member => member.ref.id === id) >
				members.findIndex(member => member.ref.id === this.ownId)
					? "left"
					: "right";
			await this.#attach(target.session, this.ctx.ui.captureViewport(), direction);
			this.ctx.showStatus(
				target.session.isStreaming ? `Switched to ${label} — it is still running` : `Switched to ${label}`,
			);
		} finally {
			this.#switching = false;
		}
	}

	/** Switch to the member `steps` after the one on screen, wrapping. */
	async cycle(steps: 1 | -1): Promise<void> {
		const members = this.members();
		if (members.length < 2) return;
		const index = members.findIndex(member => member.ref.id === this.ownId);
		const next = members[(index + steps + members.length) % members.length];
		if (next) await this.switchTo(next.ref.id);
	}

	/**
	 * Open the strip with the cursor on the next peer, so `→→ Enter` is the
	 * fastest path to the conversation beside this one. With no peer to show
	 * the strip stays closed and the status line says how to get one.
	 */
	open(): void {
		const members = this.members();
		if (members.length < 2) {
			this.ctx.showStatus("No peer conversations — /room new opens one beside this");
			return;
		}
		const index = members.findIndex(member => member.ref.id === this.ownId);
		const next = members[(index + 1) % members.length];
		this.#selectedId = next?.ref.id ?? members[0]?.ref.id;
		this.render();
	}

	close(): void {
		if (this.#selectedId === undefined) return;
		this.#selectedId = undefined;
		this.render();
	}

	/** Move the strip cursor by `steps`, wrapping. No-op while closed. */
	moveSelection(steps: 1 | -1): void {
		if (this.#selectedId === undefined) return;
		const members = this.members();
		if (members.length === 0) return;
		const index = Math.max(
			0,
			members.findIndex(member => member.ref.id === this.#selectedId),
		);
		this.#selectedId = members[(index + steps + members.length) % members.length]?.ref.id;
		this.render();
	}

	/** Close the strip and switch to the member under the cursor. */
	async confirm(): Promise<void> {
		const id = this.#selectedId;
		this.close();
		if (id !== undefined) await this.switchTo(id);
	}

	/** Redraw the anchored strip from the registry; clears it while closed. */
	render(): void {
		this.ctx.roomContainer.clear();
		if (this.#selectedId === undefined) {
			this.ctx.ui.requestRender();
			return;
		}
		const line = renderRoomStripLine(this.members(), {
			columns: Math.max(1, this.ctx.ui.terminal.columns - STRIP_PADDING_X * 2),
			currentId: this.ownId,
			selectedId: this.#selectedId,
		});
		if (line === undefined) {
			// The room shrank to one member under an open strip.
			this.#selectedId = undefined;
		} else {
			this.ctx.roomContainer.addChild(new Text(line, STRIP_PADDING_X, 0));
		}
		this.ctx.ui.requestRender();
	}

	/** One-line summary for `/room`. */
	describe(): string {
		const members = this.members();
		if (members.length < 2) return "No peer conversations. /room new opens one beside this.";
		const rows = members.map((member, index) => {
			const mark = member.ref.id === this.ownId ? "*" : " ";
			return `${mark} ${index + 1}. ${roomMemberLabel(member, index)} [${member.ref.status}] ${member.ref.id}`;
		});
		return `Room (${members.length}):\n${rows.join("\n")}\n/room <n> switches · →→ opens the strip`;
	}

	/** Resolve a `/room <n>` or `/room <id>` argument to a member id. */
	resolveArgument(argument: string): string | undefined {
		const members = this.members();
		const ordinal = Number.parseInt(argument, 10);
		if (Number.isInteger(ordinal) && String(ordinal) === argument) {
			return members[ordinal - 1]?.ref.id;
		}
		return members.find(member => member.ref.id === argument)?.ref.id;
	}

	#labelOf(id: string | undefined): string {
		const members = this.members();
		const index = members.findIndex(member => member.ref.id === id);
		const member = members[index];
		return member ? roomMemberLabel(member, index) : (id ?? "the session");
	}

	/**
	 * Keys the open strip owns. Everything else closes it and falls through, so
	 * a user who starts typing never has to dismiss the strip first.
	 */
	#onInput(data: string): { consume: true } | undefined {
		if (this.#selectedId === undefined) return undefined;
		if (matchesKey(data, "escape")) {
			this.close();
			return { consume: true };
		}
		if (matchesKey(data, "left")) {
			this.moveSelection(-1);
			return { consume: true };
		}
		if (matchesKey(data, "right")) {
			this.moveSelection(1);
			return { consume: true };
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter") || data === "\n") {
			void this.confirm();
			return { consume: true };
		}
		this.close();
		return undefined;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.kind !== "main") return;
		this.#syncPeerCount();
		if (this.#selectedId !== undefined) this.render();
	}

	#syncPeerCount(): void {
		this.ctx.statusLine.setRoomPeerCount(this.registry.peers(this.ownId).length);
	}

	/**
	 * Point the screen at `next`. The sequence is the one `/new`'s hand-off and
	 * `/resume`'s live re-attach already perform, in their order: attach, re-root
	 * if the peer's cwd differs, then rebuild every session-derived surface.
	 *
	 * `from` is the window the caller captured before anything changed. With
	 * it, the transition is a viewport slide: the screen on show moves off in
	 * `direction` and the peer's window follows it in, ending in the same
	 * authoritative paint a switch without one performs. The slide is started
	 * in the same tick as the rebuild so no render queued by the rebuild
	 * reaches the screen before it; each one is folded into the slide's last
	 * frame. A re-root is awaited before the rebuild, so on that path alone the
	 * status line may repaint for the new cwd before the transcript slides; the
	 * transcript itself is unchanged until the rebuild. Without `from`, or
	 * where the engine refuses the slide (a resize since the capture, an
	 * overlay, a multiplexer), the plain repaint stands.
	 */
	async #attach(next: AgentSession, from: ViewportSnapshot | undefined, direction: "left" | "right"): Promise<void> {
		const previousCwd = this.ctx.sessionManager.getCwd();
		this.close();
		// A peer still finishing a turn is in the background set from the switch
		// that left it; it is on screen again now, so it leaves that set before
		// the one being left enters it.
		BackgroundSessions.global().release(next);
		this.ctx.attachMainSession(next);
		const nextCwd = next.sessionManager.getCwd();
		if (normalizePathForComparison(nextCwd) !== normalizePathForComparison(previousCwd)) {
			await this.ctx.applyCwdChange(nextCwd);
		}
		this.ctx.resetObserverRegistry();
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		this.ctx.clearTransientSessionUi();
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		const sliding = from !== undefined && this.ctx.ui.slideViewport(from, direction);
		await this.ctx.reloadTodos();
		this.#syncPeerCount();
		if (!sliding) this.ctx.ui.requestRender(true, { clearScrollback: true });
	}
}
