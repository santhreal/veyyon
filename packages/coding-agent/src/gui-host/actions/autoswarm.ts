/**
 * What a window sends the autoswarm console it has open.
 *
 * Every request names the session the console belongs to, and a request whose
 * session is not the one this window holds is refused: a console left open
 * while the window moved to another session would otherwise change a setup
 * belonging to a session nobody is looking at.
 *
 * Nothing here decides anything about a swarm. Each handler hands the request
 * to the console model through `autoswarm-bridge`, which publishes the
 * console the model produced; the reply carries only whether the request was
 * taken, and why it was not.
 */
import type { AutoswarmConsole, ConsoleRefusal } from "../autoswarm-bridge";
import { ALL_AUTOSWARM_ACTIONS } from "../wire";
import { activeManager } from "./active-session";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

interface ConsoleRequest {
	session?: string;
	field?: string;
	text?: string;
	number?: number;
	on?: boolean;
	action?: string;
	name?: string;
}

function refuse(ctx: ActionContext, refusal: ConsoleRefusal): void {
	ctx.reply.failure(refusal);
}

/**
 * The console this request acts on, or the refusal that states why there is
 * none: no session on the window, another session's console, or no console
 * open on this one.
 */
function consoleFor(ctx: ActionContext, payload: ConsoleRequest): AutoswarmConsole | ConsoleRefusal {
	const session = activeManager(ctx)?.getSessionId();
	if (!session) {
		return {
			scope: "Session",
			code: "NO_SESSION",
			message: "This window holds no session. Open one, then run /autoswarm in it.",
			retryable: false,
		};
	}
	if (typeof payload.session === "string" && payload.session !== session) {
		return {
			scope: "Session",
			code: "SESSION_MISMATCH",
			message: `This window is on session ${session}. Open ${payload.session} to act on its console.`,
			retryable: false,
		};
	}
	const surface = ctx.clientState.autoswarm;
	if (!surface?.isOpen) {
		return {
			scope: "Extension",
			code: "NO_CONSOLE",
			message: "This window has no autoswarm console open. Run /autoswarm to open one, then act on it.",
			retryable: false,
		};
	}
	return surface;
}

function isConsole(resolved: AutoswarmConsole | ConsoleRefusal): resolved is AutoswarmConsole {
	return "isOpen" in resolved;
}

/** Set one row of the console from the value the window sent. */
const handleSetAutoswarmField: ActionHandler<ConsoleRequest> = (ctx, payload) => {
	const resolved = consoleFor(ctx, payload);
	if (!isConsole(resolved)) return refuse(ctx, resolved);
	if (typeof payload.field !== "string" || payload.field.length === 0) {
		return refuse(ctx, {
			scope: "Extension",
			code: "INVALID_ARGUMENTS",
			message: "SetAutoswarmField needs the id of the row to set. Send the id the console states.",
			retryable: false,
		});
	}
	const refusal = resolved.setField(payload.field, {
		text: payload.text,
		number: payload.number,
		on: payload.on,
	});
	if (refusal) return refuse(ctx, refusal);
	ctx.reply.success();
};

/** Run one of the actions the console offers. */
const handleRunAutoswarmAction: ActionHandler<ConsoleRequest> = (ctx, payload) => {
	const resolved = consoleFor(ctx, payload);
	if (!isConsole(resolved)) return refuse(ctx, resolved);
	const action = ALL_AUTOSWARM_ACTIONS.find(known => known === payload.action);
	if (!action) {
		return refuse(ctx, {
			scope: "Extension",
			code: "INVALID_ARGUMENTS",
			message: `'${String(payload.action)}' is not an autoswarm action. Send one the console offers.`,
			retryable: false,
		});
	}
	const refusal = resolved.act(action);
	if (refusal) return refuse(ctx, refusal);
	ctx.reply.success();
};

/** Save the setup on the console under a name. */
const handleSaveAutoswarmPreset: ActionHandler<ConsoleRequest> = (ctx, payload) => {
	const resolved = consoleFor(ctx, payload);
	if (!isConsole(resolved)) return refuse(ctx, resolved);
	const name = typeof payload.name === "string" ? payload.name.trim() : "";
	if (name.length === 0) {
		return refuse(ctx, {
			scope: "Extension",
			code: "INVALID_ARGUMENTS",
			message: "A preset needs a name. Type one, then save the setup under it.",
			retryable: false,
		});
	}
	const refusal = resolved.savePreset(name);
	if (refusal) return refuse(ctx, refusal);
	ctx.reply.success();
};

/** Remove the saved preset the console's rows currently equal. */
const handleDeleteAutoswarmPreset: ActionHandler<ConsoleRequest> = (ctx, payload) => {
	const resolved = consoleFor(ctx, payload);
	if (!isConsole(resolved)) return refuse(ctx, resolved);
	const refusal = resolved.deletePreset();
	if (refusal) return refuse(ctx, refusal);
	ctx.reply.success();
};

/**
 * Close the console without running anything.
 *
 * The command that opened it is waiting on the close, so this is what lets it
 * finish: the window leaves the surface and the loop stays as it stands.
 */
const handleCloseAutoswarmConsole: ActionHandler<ConsoleRequest> = (ctx, payload) => {
	const resolved = consoleFor(ctx, payload);
	if (!isConsole(resolved)) return refuse(ctx, resolved);
	resolved.close();
	ctx.reply.success();
};

export const autoswarmActionHandlers: ActionHandlersMap = {
	SetAutoswarmField: handleSetAutoswarmField as ActionHandler<never>,
	RunAutoswarmAction: handleRunAutoswarmAction as ActionHandler<never>,
	SaveAutoswarmPreset: handleSaveAutoswarmPreset as ActionHandler<never>,
	DeleteAutoswarmPreset: handleDeleteAutoswarmPreset as ActionHandler<never>,
	CloseAutoswarmConsole: handleCloseAutoswarmConsole as ActionHandler<never>,
};
