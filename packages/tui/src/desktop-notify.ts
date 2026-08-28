// Linux desktop notification delivery via D-Bus (notify-send / gdbus).

import { APP_DISPLAY_NAME } from "@veyyon/utils/app-identity";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { $which } from "@veyyon/utils/which";
import type { TerminalId, TerminalNotification } from "./terminal-capabilities";

/** Application name surfaced as the notification source. */

/** Resolved notifier binary used to fan a notification out to D-Bus. */
export type DesktopNotifierKind = "notify-send" | "gdbus";

export interface DesktopNotifier {
	kind: DesktopNotifierKind;
	path: string;
}

/**
 * Whether the current process can reach a freedesktop notification daemon:
 * Linux platform + a session bus address in env. Caller is still responsible
 * for resolving a delivery binary via {@link resolveDesktopNotifier}.
 */
export function hasLinuxDesktopSession(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	if (platform !== "linux") return false;
	return Boolean(env.DBUS_SESSION_BUS_ADDRESS);
}

/** Whether desktop notification should be dispatched via D-Bus for this terminal. */
export function shouldDeliverDesktopNotification(
	_terminalId: TerminalId,
	notifyProtocolIsBell: boolean,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	if (!notifyProtocolIsBell) return false;
	if (!hasLinuxDesktopSession(platform, env)) return false;
	if (env.VEYYON_NO_DESKTOP_NOTIFY === "1") return false;
	return true;
}

let cachedNotifier: DesktopNotifier | null | undefined;

/** Reset the cached notifier resolution. Tests only. */
export function resetDesktopNotifierCache(): void {
	cachedNotifier = undefined;
}

/** Locate a libnotify delivery binary on PATH (notify-send or gdbus). */
export function resolveDesktopNotifier(): DesktopNotifier | null {
	if (cachedNotifier !== undefined) return cachedNotifier;
	const notifySend = $which("notify-send");
	if (notifySend) {
		cachedNotifier = { kind: "notify-send", path: notifySend };
		return cachedNotifier;
	}
	const gdbus = $which("gdbus");
	if (gdbus) {
		cachedNotifier = { kind: "gdbus", path: gdbus };
		return cachedNotifier;
	}
	cachedNotifier = null;
	return null;
}

interface ResolvedNotificationFields {
	title: string;
	body: string;
	urgency: "low" | "normal" | "critical";
}

function resolveFields(message: string | TerminalNotification): ResolvedNotificationFields {
	if (typeof message === "string") {
		return { title: APP_DISPLAY_NAME, body: message, urgency: "normal" };
	}
	const title = message.title?.trim() || APP_DISPLAY_NAME;
	const body = message.body ?? "";
	const urgency = message.urgency === "critical" || message.urgency === "low" ? message.urgency : "normal";
	return { title, body, urgency };
}

const URGENCY_BYTE: Record<ResolvedNotificationFields["urgency"], number> = {
	low: 0,
	normal: 1,
	critical: 2,
};

/** Build command arguments to deliver message through the resolved notifier. */
export function buildDesktopNotifyCommand(notifier: DesktopNotifier, message: string | TerminalNotification): string[] {
	const { title, body, urgency } = resolveFields(message);
	if (notifier.kind === "notify-send") {
		return [notifier.path, "--app-name", APP_DISPLAY_NAME, `--urgency=${urgency}`, "--expire-time=5000", title, body];
	}
	const hints = `{"urgency": <byte ${URGENCY_BYTE[urgency]}>}`;
	return [
		notifier.path,
		"call",
		"--session",
		"--dest",
		"org.freedesktop.Notifications",
		"--object-path",
		"/org/freedesktop/Notifications",
		"--method",
		"org.freedesktop.Notifications.Notify",
		APP_DISPLAY_NAME,
		"0",
		"",
		title,
		body,
		"[]",
		hints,
		"5000",
	];
}

/** Fire-and-forget D-Bus desktop notification. */
export function sendDesktopNotification(message: string | TerminalNotification): void {
	const notifier = resolveDesktopNotifier();
	if (!notifier) return;
	try {
		// `.unref()` lets the event loop exit while the notifier is still running.
		// Without it, an unresponsive D-Bus activation (slow `notify-send`, hung
		// `gdbus` waiting on a stalled session bus) would keep `veyyon` alive past
		// the renderer's shutdown — a completion toast must never delay process
		// exit. Ignored stdio alone does not detach the child from the parent's
		// reference count.
		const child = Bun.spawn({
			cmd: buildDesktopNotifyCommand(notifier, message),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		child.unref();
	} catch (error) {
		// Best-effort — a broken notifier must not crash rendering — but say
		// so: a silent failure means the user never learns why attention
		// pings stopped arriving.
		logger.warn("desktop notification spawn failed; notifications will not appear", {
			error: errorMessage(error),
		});
	}
}
