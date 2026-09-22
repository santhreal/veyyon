/**
 * Interface and terminal adapter for presentation layer interactions required by CollabHost.
 *
 * CollabHost delegates status updates, render requests, queued prompt notifications,
 * status line messages, and context usage reads through this abstraction.
 */

export interface CollabHostSurface {
	/** State the share's role and participant count, or clear it when null. */
	setCollabStatus(status: { role: "host"; participantCount: number } | null): void;

	/** Request a redraw of the drawing surface. */
	requestRender(): void;

	/** Restate queued prompts / pending messages. */
	updatePendingMessagesDisplay(): void;

	/** Show a status line message. */
	showStatus(message: string, options?: { dim?: boolean }): void;

	/** Read the cached context breakdown, or null when unavailable. */
	getCachedContextBreakdown(): { usedTokens: number | null; contextWindow: number } | null;
}

export interface TerminalSurfaceContext {
	statusLine: {
		setCollabStatus(status: { role: "host"; participantCount: number } | null): void;
		invalidate(): void;
		getCachedContextBreakdown(): { usedTokens: number | null; contextWindow: number };
	};
	ui: {
		requestRender(): void;
	};
	updatePendingMessagesDisplay(): void;
	showStatus(message: string, options?: { dim?: boolean }): void;
}

/**
 * Construct a CollabHostSurface backed by terminal interactive context components.
 */
export function createTerminalCollabHostSurface(ctx: TerminalSurfaceContext): CollabHostSurface {
	return {
		setCollabStatus(status) {
			ctx.statusLine.setCollabStatus(status);
			ctx.statusLine.invalidate();
		},
		requestRender() {
			ctx.ui.requestRender();
		},
		updatePendingMessagesDisplay() {
			ctx.updatePendingMessagesDisplay();
		},
		showStatus(message, options) {
			ctx.showStatus(message, options);
		},
		getCachedContextBreakdown() {
			return ctx.statusLine.getCachedContextBreakdown();
		},
	};
}
