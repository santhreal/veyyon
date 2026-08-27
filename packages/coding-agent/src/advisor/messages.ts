/**
 * The advisor's user-facing one-liners, in one place.
 *
 * `/advisor` answers on two surfaces — the TUI status report and the text-mode
 * transcript a headless client reads — and they took different routes to the same
 * question, so the headless answer stopped one line short of the fix. These strings
 * have no other owner, and both surfaces call them.
 */

/**
 * What to report after `/advisor on|off`.
 *
 * Turning it on can leave it not running: the setting is one half, a model resolving
 * for the `advisor` role is the other. Echoing the request back ("Advisor enabled")
 * would claim a thing that did not happen, so the outcome is read from
 * `setAdvisorEnabled` and reported instead of the ask.
 */
export function describeAdvisorToggle(enabled: boolean, running: boolean): string {
	if (!enabled) return "Advisor stopped for this session.";
	return running
		? "Advisor started for this session."
		: "Advisor enabled, but no model resolved for the advisor role — assign one with /model.";
}

/**
 * The next move after `/advisor status`, given what the status just reported.
 *
 * "Off" and "on but no model resolved" need different fixes — the `advisor.enabled`
 * setting versus a `modelRoles.advisor` assignment — so each carries its own
 * instruction instead of one generic line.
 */
export function advisorStatusNextStep(configured: boolean, active: boolean): string {
	if (!configured) return "Turn it on for this session with /advisor on, or set advisor.enabled in /settings.";
	if (!active) return "Assign an advisor model with /model, under the advisor role.";
	return "Edit the roster with /advisor configure.";
}
