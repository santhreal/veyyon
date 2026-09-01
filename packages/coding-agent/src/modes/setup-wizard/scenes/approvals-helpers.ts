import type { SelectItem } from "@veyyon/tui";
import { AUTONOMY_LABEL, type AutonomyLevel } from "../../../tools/approval-modes";

export const MAX_VISIBLE = 6;

export const RUNG_ITEMS: readonly SelectItem[] = (
	[
		["ask", "Asks first for every tool call"],
		["ask-command", "Asks before running a command"],
		["auto", "Runs; boundary checks still ask"],
		["yolo", "Only destructive commands ask"],
	] as const satisfies readonly (readonly [AutonomyLevel, string])[]
).map(([value, description]) => ({ value, label: AUTONOMY_LABEL[value], description }));
