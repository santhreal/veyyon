/** The advisor's user-facing one-liners, in one place. `/advisor` answers on two surfaces — the TUI status report and the text-mode */

/** What to report after `/advisor on|off`. Turning it on can leave it not running: the setting is one half, a model resolving */
export function describeAdvisorToggle(enabled: boolean, running: boolean): string {
	if (!enabled) return "Advisor stopped for this session.";
	return running
		? "Advisor started for this session."
		: "Advisor enabled, but no model resolved for the advisor role — assign one with /model.";
}

/** The next move after `/advisor status`, given what the status just reported. "Off" and "on but no model resolved" need different fixes — the `advisor.enabled` */
export function advisorStatusNextStep(configured: boolean, active: boolean): string {
	if (!configured) return "Turn it on for this session with /advisor on, or set advisor.enabled in /settings.";
	if (!active) return "Assign an advisor model with /model, under the advisor role.";
	return "Edit the roster with /advisor configure.";
}
