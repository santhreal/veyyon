import { collapseWhitespace, errorMessage, logger } from "@veyyon/utils";
import { theme } from "../../../modes/theme/theme";

export interface ToolDefView {
	parameters?: unknown;
	inputSchema?: unknown;
}
export interface ParamSpecView {
	type?: string;
	default?: unknown;
}
export interface JsonSchemaView {
	properties?: Record<string, unknown>;
	required?: string[];
}
export interface SkillView {
	prompt?: string;
	instruction?: string;
	content?: string;
}
export interface McpConfigView {
	transport?: string;
	type?: string;
	command?: string;
	cmd?: string;
	args?: string[];
	arguments?: string[];
	env?: Record<string, unknown>;
}

export function unreadableRows(subject: string, error: unknown): string[] {
	logger.warn("Extension inspector could not read a definition", { subject, error: String(error) });
	return [theme.fg("warning", `  (unable to read the ${subject}: ${collapseWhitespace(errorMessage(error))})`)];
}
