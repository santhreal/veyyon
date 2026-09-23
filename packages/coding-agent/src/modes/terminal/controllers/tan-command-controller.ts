import { dispatchTan } from "../../../task/tan";
import type { InteractiveModeContext } from "../types";

/**
 * The slice of the interactive context this controller uses: 7 members of the
 * 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces (see
 * `CollabHostContext`).
 */
export type TanCommandControllerContext = Pick<
	InteractiveModeContext,
	"mcpManager" | "rebuildChatFromMessages" | "session" | "sessionManager" | "settings" | "showError" | "showStatus"
>;

/** States a `/tan` dispatch on the terminal's own status and error lines. */
export class TanCommandController {
	constructor(private readonly ctx: TanCommandControllerContext) {}

	async start(work: string): Promise<void> {
		const dispatch = await dispatchTan(
			{
				session: this.ctx.session,
				sessionManager: this.ctx.sessionManager,
				settings: this.ctx.settings,
				mcpManager: this.ctx.mcpManager,
			},
			work,
		);
		if (!dispatch.ok) {
			if (dispatch.reason === "usage") this.ctx.showStatus(dispatch.message);
			else this.ctx.showError(dispatch.message);
			return;
		}
		if (dispatch.recorded === "now") this.ctx.rebuildChatFromMessages();
		this.ctx.showStatus(`Dispatched background tan ${dispatch.jobId}`);
	}
}
