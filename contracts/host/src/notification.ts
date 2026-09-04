/**
 * An out-of-band notification a tool asks its host to deliver.
 *
 * A tool decides THAT the operator should be told something; the host decides
 * how. A terminal emits OSC 99 and the desktop shows a banner, a GUI raises its
 * own toast, and a headless run installs no notifier at all, which is why the
 * capability is reported as absent rather than accepted and dropped.
 *
 * Every field here is a statement about the message, never about a terminal:
 * a host that is not a terminal can honour all of them. Terminal-only controls
 * (icon names, sounds, expiry, delivery while the window holds focus) belong to
 * the terminal's own payload, which extends this one.
 */
export interface HostNotification {
	title?: string;
	body?: string;
	/** Free-form category the host may route or filter on. */
	type?: string | string[];
	urgency?: "low" | "normal" | "critical";
	/** What activating the notification should do, where the host can act on it. */
	actions?: "focus" | "report" | "focus-report" | "none";
}

/**
 * The host's delivery function, installed by whichever host is running.
 *
 * Absent means no host can deliver: a caller reads `undefined` and skips the
 * work, rather than calling a no-op that reports success.
 */
export type HostNotifier = (notification: HostNotification) => void;
