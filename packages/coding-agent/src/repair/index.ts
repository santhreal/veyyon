export {
	createRepairToolCallArgumentsHook,
	formatUnrepairableToolError,
} from "./agent-hook";
export {
	type AliasKeyRepairPlan,
	detectAmbiguousRequiredStringRepair,
	detectStrictUnknownKeyRepair,
	formatRepairCoachingHints,
	isToolCallRepairDisabled,
	MAX_REPAIR_INPUT_BYTES,
	planAliasKeyRepairs,
	repairToolCallArguments,
	type ToolCallRepairOutcome,
	type ToolCallRepairStatus,
} from "./schema-repair";
