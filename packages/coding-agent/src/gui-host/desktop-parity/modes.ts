/**
 * How the desktop enters, leaves and steers every mode a session exposes.
 *
 * Member ids: a settable mode by its wire spelling (`plan`, `vibe`, `loop`,
 * `none`), a session mode by the name of its `AgentSession` accessor with the
 * first letter lowered (`getGoalModeState` is `goal`, `setFastMode` is `fast`),
 * a goal control as `goal.<op>` and an autoswarm console action as
 * `autoswarm.<action>`.
 */
import type { DesktopCarrier } from "./carrier";

export const SESSION_MODE_CARRIERS: Readonly<Record<string, DesktopCarrier>> = {
	plan: { action: "SetSessionMode" },
	vibe: { action: "SetSessionMode" },
	loop: { action: "SetSessionMode" },
	none: { action: "SetSessionMode" },
	// Goal mode starts from an objective, so the window sets one rather than
	// sending a mode name.
	goal: { action: "SetGoal" },
	"goal.pause": { action: "ControlGoal" },
	"goal.resume": { action: "ControlGoal" },
	"goal.drop": { action: "ControlGoal" },
	// `/fast` is a text-mode command, which `RunCommand` runs for a window.
	fast: { action: "RunCommand" },
	steering: { setting: "steeringMode" },
	followUp: { setting: "followUpMode" },
	interrupt: { setting: "interruptMode" },
	"autoswarm.start": { action: "RunAutoswarmAction" },
	"autoswarm.resume": { action: "RunAutoswarmAction" },
	"autoswarm.pause": { action: "RunAutoswarmAction" },
	"autoswarm.new": { action: "RunAutoswarmAction" },
	"autoswarm.stop": { action: "RunAutoswarmAction" },
	"autoswarm.clear": { action: "RunAutoswarmAction" },
	"autoswarm.reset": { action: "RunAutoswarmAction" },
};
