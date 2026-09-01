import { Spacer, Text } from "@veyyon/tui";
import type { LspStartupEvent } from "../../lsp/startup-events";
import type { McpConnectionStatusEvent } from "../../mcp/startup-events";
import type { InteractiveMode } from "../interactive-mode";
import type { SessionObserverChangeKind } from "../session-observer-registry";
import { ANCHORED_BLOCK_PADDING_X } from "./todo-board-manager";

export class EventHandlers {
	#host: InteractiveMode;
	#mcpPendingServers = new Set<string>();
	#mcpConnectedServers = new Set<string>();
	#mcpFailedServers = new Map<string, { error: string; foreign: boolean }>();
	#modelCycleClearTimer: NodeJS.Timeout | undefined;
	#observerUiSyncTimer: NodeJS.Timeout | undefined;
	#observerUiSyncNeedsTodoReconcile = false;

	constructor(host: InteractiveMode) {
		this.#host = host;
	}

	get mcpPendingServers(): Set<string> {
		return this.#mcpPendingServers;
	}

	get mcpConnectedServers(): Set<string> {
		return this.#mcpConnectedServers;
	}

	get mcpFailedServers(): Map<string, { error: string; foreign: boolean }> {
		return this.#mcpFailedServers;
	}

	handleMcpConnectionStatusEvent(event: McpConnectionStatusEvent): void {
		if (this.#host.settings.get("startup.quiet")) return;
		if (event.type === "connecting") {
			this.#mcpPendingServers.clear();
			this.#mcpConnectedServers.clear();
			this.#mcpFailedServers.clear();
			for (const serverName of event.serverNames) {
				this.#mcpPendingServers.add(serverName);
			}
		} else if (event.type === "connected") {
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpFailedServers.delete(event.serverName);
			this.#mcpConnectedServers.add(event.serverName);
		} else {
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpConnectedServers.delete(event.serverName);
			this.#mcpFailedServers.set(event.serverName, { error: event.error, foreign: event.foreign === true });
		}
		this.#host.ui.requestRender();
	}

	handleLspStartupEvent(event: LspStartupEvent): void {
		this.#host.ui.requestRender();
		if (event.type === "failed") {
			this.#host.showWarning(`LSP startup failed: ${event.error}. It will retry lazily on write.`);
			return;
		}

		const failedServers = event.servers.filter(server => server.status === "error");

		if (failedServers.length === 1) {
			const failedServer = failedServers[0];
			const detail = failedServer.error ? `: ${failedServer.error}` : "";
			this.#host.showWarning(`LSP startup failed for ${failedServer.name}${detail}. It will retry lazily on write.`);
			return;
		}

		if (failedServers.length > 1) {
			const failedNames = failedServers.map(server => server.name).join(", ");
			this.#host.showWarning(`LSP startup failed for ${failedNames}. It will retry lazily on write.`);
		}
	}

	showModelCycleTrack(track: string): void {
		this.renderModelCycleTrack(track);
		this.syncModelCycleClearTimer();
		this.#host.ui.requestRender();
	}

	renderModelCycleTrack(track: string | null): void {
		this.#host.modelCycleContainer.clear();
		if (!track) return;
		this.#host.modelCycleContainer.addChild(new Spacer(1));
		this.#host.modelCycleContainer.addChild(new Text(track, ANCHORED_BLOCK_PADDING_X, 0));
	}

	cancelModelCycleClearTimer(): void {
		if (!this.#modelCycleClearTimer) return;
		clearTimeout(this.#modelCycleClearTimer);
		this.#modelCycleClearTimer = undefined;
	}

	syncModelCycleClearTimer(): void {
		this.cancelModelCycleClearTimer();
		this.#modelCycleClearTimer = setTimeout(() => {
			this.#modelCycleClearTimer = undefined;
			this.renderModelCycleTrack(null);
			this.#host.ui.requestRender();
		}, 3000);
		this.#modelCycleClearTimer.unref?.();
	}

	scheduleObserverUiSync(kind: SessionObserverChangeKind): void {
		if (kind !== "progress") {
			this.#observerUiSyncNeedsTodoReconcile = true;
		}
		if (this.#observerUiSyncTimer) return;
		this.#observerUiSyncTimer = setTimeout(() => {
			this.#observerUiSyncTimer = undefined;
			this.flushObserverUiSync();
		}, 100);
		this.#observerUiSyncTimer.unref?.();
	}

	flushObserverUiSync(): void {
		this.#host.syncRunningSubagentBadge({ requestRender: false });
		if (this.#observerUiSyncNeedsTodoReconcile) {
			this.#observerUiSyncNeedsTodoReconcile = false;
			this.#host.todoBoardManager.reconcileTodosWithSubagents();
		}
		this.#host.todoBoardManager.renderSubagentList();
		this.#host.ui.requestRender();
	}

	cancelObserverUiSyncTimer(): void {
		if (this.#observerUiSyncTimer) {
			clearTimeout(this.#observerUiSyncTimer);
			this.#observerUiSyncTimer = undefined;
		}
		this.#observerUiSyncNeedsTodoReconcile = false;
	}

	dispose(): void {
		this.cancelModelCycleClearTimer();
		this.cancelObserverUiSyncTimer();
	}
}
