/**
 * RoomController - the sideways axis of one terminal: several driving agents,
 * each with its own conversation and its own spawns, side by side, and the
 * operator moving between them.
 *
 * The runtime already existed: `AgentRegistry` holds many `kind: "main"` rows
 * per process, `attachMainSession` re-points the screen at any live session
 * and hands the displayed one to `BackgroundSessions`, and the irc bus
 * delivers by registry id. What this adds is the room (`AgentRef.room`), the
 * room view (`components/room/room-stage.ts`), the quick switch, the commands,
 * and the one transaction that puts a conversation on screen.
 *
 * A switch is a full attach, not a focus. `SessionFocusController` proxies the
 * view onto a spawn while `ctx.session` stays the driver, and the editor is a
 * plain chat box for it: no slash commands, no model cycling. A peer IS a
 * driver, so after a switch it is `ctx.session` outright and every command,
 * keybinding and status surface works on it as on the first session.
 *
 * One process scope for the room. `getProjectDir()`, the shared settings scope
 * and the capability caches are process-global, so the conversation on screen
 * holds them (`AgentSession.claimForeground`) and a conversation off screen
 * that changes directory defers its re-scope until it is back on screen.
 */

import type { OverlayHandle } from "@veyyon/tui";
import { normalizePathForComparison } from "@veyyon/utils";
import { matchesKey } from "@veyyon/utils/keys";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { truncateToWidth } from "@veyyon/utils/width";
import type { Attachment } from "@veyyon/wire/presentation";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../../registry/agent-registry";
import type { AgentSession } from "../../../session/agent-session";
import { BackgroundSessions } from "../../../session/background-sessions";
import { setSessionTerminalTitle } from "../../../utils/title-generator";
import { pointerMotionEnabled } from "../components/chrome/modal-shell";
import { type RoomLayout, RoomStage, type RoomStageHost, type RoomStageMode } from "../components/room/room-stage";
import {
	type RoomDraft,
	type RoomStageMember,
	type RoomWindowSnapshot,
	roomStateWords,
	roomWindowName,
} from "../components/room/room-view-model";
import type { InteractiveModeContext } from "../types";
import { notifyTurnComplete } from "./event-controller";
import { RoomWindowFeed, roomDraftPreview } from "./room-window-feed";

export type RoomControllerContext = Pick<
	InteractiveModeContext,
	| "applyCwdChange"
	| "attachMainSession"
	| "clearTransientSessionUi"
	| "createNextSession"
	| "dismissHeldUi"
	| "editor"
	| "eventController"
	| "focusedAgentId"
	| "hostSession"
	| "keybindings"
	| "launchSession"
	| "onWaitingDialogsChange"
	| "releaseHostedSession"
	| "reloadTodos"
	| "renderInitialMessages"
	| "resetObserverRegistry"
	| "session"
	| "sessionManager"
	| "settings"
	| "showError"
	| "showStatus"
	| "showWarning"
	| "statusLine"
	| "ui"
	| "unfocusSession"
	| "updateEditorBorderColor"
	| "waitingDialogs"
>;

/** A room member's label: `2 · refactor auth`, or `conversation 2` while it goes by nothing yet. */
function memberLabel(ordinal: number, snapshot: RoomWindowSnapshot): string {
	const name = roomWindowName(snapshot);
	return name ? `${ordinal} · ${truncateToWidth(name, 40)}` : `conversation ${ordinal}`;
}

/**
 * A conversation's unsent composer draft: the text, where the cursor was, and
 * what was attached, images included. The composer is one editor the room
 * shares, so a switch carries the whole draft away with the conversation that
 * typed it or leaves every part of it behind.
 */
interface ComposerDraft {
	readonly text: string;
	readonly cursorOffset: number;
	readonly attachments: readonly Attachment[];
	readonly imageLinks: readonly (string | undefined)[] | undefined;
	/** The draft as the conversation's window shows it. */
	readonly preview: RoomDraft | undefined;
}

/**
 * A room member with a session attached. The registry lists a driving agent
 * from the moment it registers, and its session attaches after, so a row can
 * be a member for a render or two before it has anything to show.
 */
type LiveMember = AgentRef & { readonly session: AgentSession };

function isLive(ref: AgentRef): ref is LiveMember {
	return ref.session !== null;
}

export class RoomController {
	#registryUnsubscribe: (() => void) | undefined;
	#waitingUnsubscribe: (() => void) | undefined;
	/** One feed per room member, keyed by registry id; built as members arrive, disposed as they leave. */
	readonly #feeds = new Map<string, RoomWindowFeed>();
	/** The unsent draft each off-screen conversation had in the composer when it left the screen. */
	readonly #drafts = new Map<AgentSession, ComposerDraft>();
	/**
	 * The draft the composer holds for the conversation on screen, as its window
	 * shows it. Read when the room view opens and when a switch puts a draft in
	 * the composer; the composer does not take input while the view is open.
	 */
	#composerDraft: RoomDraft | undefined;
	/** Held-dialog counts last seen, so a conversation that starts waiting is announced once. */
	readonly #lastWaiting = new Map<AgentSession, number>();
	#stage: { readonly component: RoomStage; readonly overlay: OverlayHandle; readonly originId: string } | undefined;
	/** Serializes screen changes: a second one while one is in flight is dropped. */
	#switching = false;
	/** A new conversation is being built: a second request waits for nothing and is refused. */
	#creating = false;
	/**
	 * Whether the room view has been opened, or its key shown, in this process.
	 * The first arrival in another conversation says how to see them all, once.
	 */
	#viewKnown = false;

	constructor(
		private readonly ctx: RoomControllerContext,
		private readonly registry: AgentRegistry = AgentRegistry.global(),
	) {}

	/** Subscribe to the registry and the dialog counts. Idempotent. */
	install(): void {
		this.#registryUnsubscribe ??= this.registry.onChange(event => this.#onRegistryEvent(event));
		this.#waitingUnsubscribe ??= this.ctx.onWaitingDialogsChange(() => this.#onWaitingChange());
		this.#syncFeeds();
		this.#syncStatus();
	}

	dispose(): void {
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		this.#waitingUnsubscribe?.();
		this.#waitingUnsubscribe = undefined;
		this.#closeStage();
		for (const feed of this.#feeds.values()) feed.dispose();
		this.#feeds.clear();
	}

	/** Whether the room view is on screen. */
	get viewOpen(): boolean {
		return this.#stage !== undefined;
	}

	/** Registry id of the driving agent on screen. */
	get ownId(): string {
		return this.ctx.session.getAgentId() ?? MAIN_AGENT_ID;
	}

	/** Every driving agent in the room with a live session, the one on screen included, oldest first. */
	#refs(): LiveMember[] {
		return this.registry.roomMembers(this.ownId).filter(isLive);
	}

	/** The room as the stage draws it. */
	members(): RoomStageMember[] {
		const originId = this.#stage?.originId ?? this.ownId;
		return this.#refs().map(ref => {
			const feed = this.#feedFor(ref);
			const session = ref.session;
			return {
				id: ref.id,
				snapshot: () => feed.snapshot(),
				waitingDialogs: this.ctx.waitingDialogs(session),
				draft:
					this.#drafts.get(session)?.preview ?? (session === this.ctx.session ? this.#composerDraft : undefined),
				origin: ref.id === originId,
			};
		});
	}

	#feedFor(ref: LiveMember): RoomWindowFeed {
		let feed = this.#feeds.get(ref.id);
		if (!feed || feed.session !== ref.session) {
			feed?.dispose();
			feed = new RoomWindowFeed(ref.session, event => this.#onFeedEvent(ref.session, event));
			this.#feeds.set(ref.id, feed);
		}
		return feed;
	}

	/** Build feeds for arriving members and drop those of members that left. */
	#syncFeeds(): void {
		const refs = this.#refs();
		const live = new Set(refs.map(ref => ref.id));
		for (const [id, feed] of this.#feeds) {
			if (!live.has(id)) {
				feed.dispose();
				this.#feeds.delete(id);
			}
		}
		if (refs.length > 1) for (const ref of refs) this.#feedFor(ref);
	}

	#onFeedEvent(session: AgentSession, event: string): void {
		if (this.#stage) this.ctx.ui.requestRender();
		if (event === "agent_end") this.#onTurnEnd(session);
		if (event === "agent_start" || event === "agent_end") this.#syncStatus();
	}

	/**
	 * A conversation off screen ended its turn: say so on the status line, once,
	 * with the way to it, and send the completion notification titled with its
	 * label. The window's state decides what ended: a stopped turn says nothing,
	 * and an end that a retry or a continuation has already taken up reads as
	 * working and says nothing either. The room view's windows show the end
	 * themselves, so the status line stays quiet while it is open.
	 */
	#onTurnEnd(session: AgentSession): void {
		if (session === this.ctx.session) return;
		const refs = this.#refs();
		const index = refs.findIndex(ref => ref.session === session);
		const ref = refs[index];
		if (!ref) return;
		const snapshot = this.#feedFor(ref).snapshot();
		const ended = snapshot.state.kind;
		if (ended !== "done" && ended !== "failed") return;
		const label = memberLabel(index + 1, snapshot);
		if (!this.#stage) {
			this.ctx.showStatus(
				`${label} ${ended === "done" ? "finished" : "failed"} — ${this.#viewKey()} opens the room`,
			);
		}
		// A failed turn is not a completion; the notification's own gate says so.
		notifyTurnComplete(session, label);
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.kind !== "main") return;
		this.#syncFeeds();
		this.#syncStatus();
		if (this.#stage) this.ctx.ui.requestRender();
	}

	/**
	 * A conversation off screen started holding a question: say so on the
	 * status line, once, with the way to it. The room chip keeps counting it
	 * until the operator gets there.
	 */
	#onWaitingChange(): void {
		const refs = this.#refs();
		for (const [index, ref] of refs.entries()) {
			const session = ref.session;
			const now = this.ctx.waitingDialogs(session);
			const before = this.#lastWaiting.get(session) ?? 0;
			this.#lastWaiting.set(session, now);
			if (now > before && session !== this.ctx.session && !this.#stage) {
				const snapshot = this.#feedFor(ref).snapshot();
				this.ctx.showStatus(`${memberLabel(index + 1, snapshot)} needs you — ${this.#viewKey()} opens the room`);
			}
		}
		this.#syncStatus();
		if (this.#stage) this.ctx.ui.requestRender();
	}

	#syncStatus(): void {
		const peers = this.#refs().filter(ref => ref.id !== this.ownId);
		let working = 0;
		let waiting = 0;
		for (const ref of peers) {
			const session = ref.session;
			if (this.ctx.waitingDialogs(session) > 0) waiting++;
			else if (session.isStreaming) working++;
		}
		this.ctx.statusLine.setRoomPeers({ peers: peers.length, working, waiting });
	}

	/**
	 * Conversations running off screen that the room chip does not already
	 * count: the kept ones outside the room on screen. A peer that leaves the
	 * screen mid-turn is kept like any other, and counting it here too would
	 * put one turn on the status line twice, as `bg` and as `working`.
	 */
	unwatchedOutsideRoom(): number {
		const room = new Set<AgentSession>(this.#refs().map(ref => ref.session));
		let count = 0;
		for (const entry of BackgroundSessions.global().kept) if (!room.has(entry.session)) count++;
		return count;
	}

	// ------------------------------------------------------------ the room view

	/**
	 * Open the room view: the screen pulls back into its window beside every
	 * other conversation in the room. Available with no peers too, where it
	 * shows the one window and the slot that opens another.
	 */
	async openView(): Promise<void> {
		if (this.#stage || this.#switching) return;
		if (this.ctx.focusedAgentId) await this.ctx.unfocusSession();
		this.#viewKnown = true;
		this.#showStage({ kind: "overview" });
	}

	/**
	 * The key that opens the room view, as a status line says it: the first
	 * binding of `app.room.view`, which works with text in the composer, else
	 * the double tap, which does not.
	 */
	#viewKey(): string {
		return this.ctx.keybindings.getKeys("app.room.view")[0] ?? "→ twice on an empty composer";
	}

	/**
	 * Move to the member `steps` after the one on screen, wrapping: the screen
	 * pulls back, the row slides and the next conversation pushes in.
	 */
	async cycle(steps: 1 | -1): Promise<void> {
		const refs = this.#refs();
		if (refs.length < 2) {
			this.ctx.showStatus("No other conversation in this terminal — /room new opens one beside this");
			return;
		}
		const index = refs.findIndex(ref => ref.id === this.ownId);
		const next = refs[(index + steps + refs.length) % refs.length];
		if (next) await this.switchTo(next.id);
	}

	/**
	 * Put peer `id` on screen with the quick switch. Refuses a stranger: only a
	 * driving agent the registry lists as a member of this room, with a live
	 * session, is a valid target.
	 */
	async switchTo(id: string): Promise<void> {
		if (id === this.ownId) return;
		const target = this.registry.peers(this.ownId).find(ref => ref.id === id);
		if (!target) {
			this.ctx.showError(`"${id}" is not a peer of this conversation. Run /room list to see the room.`);
			return;
		}
		if (!target.session) {
			this.ctx.showError(`Peer "${id}" has no live session to switch to.`);
			return;
		}
		if (this.#stage || this.#switching) return;
		if (this.ctx.focusedAgentId) await this.ctx.unfocusSession();
		const travel: RoomStageMode = { kind: "travel", targetId: id };
		if (pointerMotionEnabled()) {
			this.#showStage(travel);
			return;
		}
		// No motion to play: the switch is the attach and one forced repaint, with
		// no alternate screen borrowed for a frame nobody sees move.
		try {
			await this.#putOnScreen(target.session);
		} catch (error) {
			this.ctx.showError(`Could not switch: ${errorMessage(error)}`);
			return;
		}
		this.#announce(id, travel);
		this.#land();
	}

	/** Open a conversation beside the one on screen and slide to it. */
	async openPeer(): Promise<void> {
		if (this.#stage || this.#switching) return;
		if (this.#creating) {
			this.ctx.showStatus("A new conversation is already opening");
			return;
		}
		let id: string;
		try {
			id = await this.#createPeer();
		} catch (error) {
			this.ctx.showError(`Could not open a peer conversation: ${errorMessage(error)}`);
			return;
		}
		await this.switchTo(id);
	}

	#showStage(mode: RoomStageMode): void {
		const originId = this.ownId;
		this.#composerDraft = this.#takeDraft()?.preview;
		const host: RoomStageHost = {
			requestRender: () => this.ctx.ui.requestRender(),
			rows: () => this.ctx.ui.terminal.rows,
			members: () => this.members(),
			prepare: id => this.#prepare(id, mode),
			land: (_id, failure) => this.#land(failure),
			create: () => this.#createPeer(),
			close: id => this.close(id),
			isToggle: data => this.ctx.keybindings.getKeys("app.room.view").some(key => matchesKey(data, key)),
		};
		const layout: RoomLayout = this.ctx.settings.get("room.view");
		const component = new RoomStage(host, {
			originId,
			originScreen: this.ctx.ui.captureViewport()?.rows,
			layout,
			mode,
		});
		const overlay = this.ctx.ui.showOverlay(component, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.#stage = { component, overlay, originId };
		this.ctx.ui.setFocus(component);
		this.ctx.ui.requestRender();
	}

	#closeStage(): void {
		const stage = this.#stage;
		if (!stage) return;
		this.#stage = undefined;
		stage.component.dispose();
		stage.overlay.hide();
		this.ctx.ui.setFocus(this.ctx.editor);
	}

	/**
	 * The stage reached full size: lift it, onto the screen it drew last.
	 * `failure` is why a quick switch came back to where it started.
	 */
	#land(failure?: unknown): void {
		this.#closeStage();
		// The new conversation's history belongs in scrollback, not the last one's.
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		if (failure !== undefined) this.ctx.showError(`Could not switch: ${errorMessage(failure)}`);
	}

	/** Say which conversation is on screen now, and whether it is still working. */
	#announce(id: string, mode: RoomStageMode): void {
		const refs = this.#refs();
		const index = refs.findIndex(ref => ref.id === id);
		const ref = refs[index];
		if (!ref) return;
		const snapshot = this.#feedFor(ref).snapshot();
		const label = memberLabel(index + 1, snapshot);
		const suffix = ref.session.isStreaming ? " — it is still working" : "";
		// The first arrival in another conversation says how to see all of them;
		// every later one only says where the screen is now.
		const teach = this.#viewKnown ? "" : ` · ${this.#viewKey()} shows every conversation`;
		this.#viewKnown = true;
		this.ctx.showStatus(`${mode.kind === "travel" ? "Switched to" : "Now on"} ${label}${suffix}${teach}`);
	}

	/**
	 * Put member `id` on the screen under the stage, say so, then compose what
	 * it draws there, so the stage's last frame is that screen exactly: an
	 * announcement written after the stage lifts would push the screen up a
	 * row under the operator's eyes.
	 */
	async #prepare(id: string, mode: RoomStageMode): Promise<readonly string[] | undefined> {
		const ref = this.registry.get(id);
		const session = ref?.session;
		if (!session || ref?.kind !== "main") throw new Error("That conversation has closed.");
		if (session !== this.ctx.session) {
			await this.#putOnScreen(session);
			this.#announce(id, mode);
		}
		return this.ctx.ui.composeViewport()?.rows;
	}

	/**
	 * The one transaction that puts a room member on screen. The process scope
	 * moves first, because it is the step that can fail: a claim that throws
	 * gives the scope back to the conversation on screen and leaves it, its
	 * background accounting and its transcript exactly as they were.
	 * Everything after the claim is the synchronous swap `/new` and `/resume`
	 * perform, the turn the member is in the middle of, and the terminal's own
	 * cwd-derived chrome, whose failure is reported without undoing a switch
	 * the operator can already see.
	 */
	async #putOnScreen(next: AgentSession): Promise<void> {
		if (this.#switching) throw new Error("Another switch is in progress.");
		this.#switching = true;
		try {
			const previous = this.ctx.session;
			const previousCwd = this.ctx.sessionManager.getCwd();
			await next.takeForegroundFrom(previous);
			// A peer still finishing a turn is in the background set from the
			// switch that left it; it is on screen again now, so it leaves that set
			// before the one being left enters it.
			BackgroundSessions.global().release(next);
			this.ctx.attachMainSession(next);
			// The conversation is on screen from here. A step below that fails is
			// reported, and the switch still stands: a stage told the switch was
			// refused would reopen over a screen that already changed.
			try {
				this.ctx.resetObserverRegistry();
				setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				this.ctx.clearTransientSessionUi();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.eventController.resumeTurn();
				const nextCwd = next.sessionManager.getCwd();
				if (normalizePathForComparison(nextCwd) !== normalizePathForComparison(previousCwd)) {
					try {
						await this.ctx.applyCwdChange(nextCwd);
					} catch (error) {
						logger.warn("Room switch: cwd chrome refresh failed", { error: errorMessage(error) });
						this.ctx.showWarning(
							`Switched, but the command list for ${nextCwd} could not be loaded: ${errorMessage(error)}`,
						);
					}
				}
				await this.ctx.reloadTodos();
			} catch (error) {
				logger.warn("Room switch: the arrival did not finish", { error: errorMessage(error) });
				this.ctx.showWarning(`Switched, but the screen did not finish loading: ${errorMessage(error)}`);
			}
		} finally {
			this.#switching = false;
		}
	}

	/**
	 * `attachMainSession` calls this on every attach, whichever path made it (a
	 * room switch, `/resume` of a running session, a `/new` hand-off).
	 *
	 * The composer is one editor every conversation shares, so the draft on it
	 * belongs to whichever conversation is on screen: it is kept for `previous`,
	 * and `next` gets its own back, or a clear composer. The room is read again
	 * from `next`'s seat: the chip counts `next`'s room, and none for a
	 * conversation outside every room.
	 */
	sessionAttached(previous: AgentSession, next: AgentSession): void {
		const leaving = this.#takeDraft();
		if (leaving) this.#drafts.set(previous, leaving);
		else this.#drafts.delete(previous);
		const arriving = this.#drafts.get(next);
		this.#putDraft(arriving);
		this.#drafts.delete(next);
		this.#composerDraft = arriving?.preview;
		this.#syncFeeds();
		this.#syncStatus();
	}

	/** The composer's draft, or nothing when it holds no text and no attachment. */
	#takeDraft(): ComposerDraft | undefined {
		const editor = this.ctx.editor;
		const text = editor.getText();
		const attachments = editor.attachments;
		if (!text.trim() && attachments.length === 0) return undefined;
		return {
			text,
			cursorOffset: editor.getCursorOffset(),
			attachments,
			imageLinks: editor.imageLinks,
			preview: roomDraftPreview(text, attachments),
		};
	}

	/** Put `draft` in the composer, replacing every part of what it held; nothing clears it. */
	#putDraft(draft: ComposerDraft | undefined): void {
		const editor = this.ctx.editor;
		editor.clearDraft();
		if (!draft) return;
		editor.setText(draft.text);
		editor.attachments = draft.attachments;
		editor.imageLinks = draft.imageLinks;
		editor.setCursorOffset(draft.cursorOffset);
	}

	/** Build a conversation in this room, off screen until the operator enters it. */
	async #createPeer(): Promise<string> {
		const createNextSession = this.ctx.createNextSession;
		if (!createNextSession) throw new Error("This terminal cannot open a second conversation.");
		if (this.#creating) throw new Error("A new conversation is already opening.");
		const room = this.registry.ensureRoom(this.ownId);
		if (room === undefined) {
			throw new Error("The current session is not registered as a driving agent, so it cannot open a room.");
		}
		this.#creating = true;
		try {
			const hosted = await createNextSession({ room });
			try {
				// Built for the room, not for the screen: until it is entered, a directory
				// it moves to must not re-scope the conversation the operator is reading.
				hosted.session.releaseForeground();
				await this.ctx.hostSession(hosted);
				const id = hosted.session.getAgentId();
				if (id === undefined) throw new Error("The new conversation did not register as a driving agent.");
				this.#syncFeeds();
				this.#syncStatus();
				return id;
			} catch (error) {
				// A conversation that did not join the room is one nothing can reach:
				// close it rather than leave it running unseen.
				this.ctx.dismissHeldUi(hosted.session);
				await hosted.session.dispose().catch((disposeError: unknown) => {
					logger.warn("A conversation that failed to open did not dispose", { error: errorMessage(disposeError) });
				});
				this.ctx.releaseHostedSession(hosted.session);
				throw error;
			}
		} finally {
			this.#creating = false;
		}
	}

	/**
	 * End conversation `id` and take it out of the room. Resolves with the
	 * reason when it is refused. The turn it is running, if any, is stopped and
	 * its transcript flushed; its unsent draft is kept beside the transcript.
	 */
	async close(id: string): Promise<string | undefined> {
		const session = this.registry.get(id)?.session;
		if (!session) return "That conversation has already closed.";
		if (session === this.ctx.session)
			return "That is the conversation on screen. Enter another one, then close it from there.";
		if (session === this.ctx.launchSession) {
			return "The first conversation holds the MCP servers and background jobs the others share, so it stays open until you exit.";
		}
		// Its held UI goes first: a tool waiting on a dialog this conversation holds
		// off screen would otherwise hold the stop below forever. It stays hosted
		// until it is disposed, so a close that fails leaves it for exit to dispose.
		this.ctx.dismissHeldUi(session);
		try {
			if (session.isStreaming) await session.abort();
			const draft = this.#drafts.get(session);
			if (draft?.text.trim()) await session.sessionManager.saveDraft(draft.text);
			this.#drafts.delete(session);
			this.#lastWaiting.delete(session);
			BackgroundSessions.global().release(session);
			await session.dispose();
			this.ctx.releaseHostedSession(session);
		} catch (error) {
			return `Could not close that conversation: ${errorMessage(error)}`;
		}
		this.#syncFeeds();
		this.#syncStatus();
		return undefined;
	}

	/**
	 * Write every off-screen conversation's unsent draft text beside its
	 * transcript. Shutdown calls this. Attached images live in the composer
	 * only, so they end with the process.
	 */
	async persistDrafts(): Promise<void> {
		for (const [session, draft] of this.#drafts) {
			if (session === this.ctx.session || !draft.text.trim()) continue;
			try {
				await session.sessionManager.saveDraft(draft.text);
			} catch (error) {
				logger.warn("Could not save a room member's draft", { error: errorMessage(error) });
			}
		}
		this.#drafts.clear();
	}

	// ------------------------------------------------------------ /room

	/** The room as text, for `/room list`. */
	describe(): string {
		const refs = this.#refs();
		if (refs.length < 2) return "No other conversation in this terminal. /room new opens one beside this.";
		const now = Date.now();
		const rows = refs.map((ref, index) => {
			const mark = ref.id === this.ownId ? "*" : " ";
			const snapshot = this.#feedFor(ref).snapshot();
			const { word, time } = roomStateWords(snapshot, now);
			const state = this.ctx.waitingDialogs(ref.session) > 0 ? "needs you" : time ? `${word} ${time}` : word;
			return `${mark} ${memberLabel(index + 1, snapshot)} [${state}] ${ref.id}`;
		});
		return `Room (${refs.length}):\n${rows.join("\n")}\n/room <n> switches · ${this.#viewKey()} opens the room view`;
	}

	/** Resolve a `/room <n>` or `/room <id>` argument to a member id. */
	resolveArgument(argument: string): string | undefined {
		const refs = this.#refs();
		const ordinal = Number.parseInt(argument, 10);
		if (Number.isInteger(ordinal) && String(ordinal) === argument) {
			return refs[ordinal - 1]?.id;
		}
		return refs.find(ref => ref.id === argument)?.id;
	}
}
