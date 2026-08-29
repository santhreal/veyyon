import { type } from "arktype";

export const setCwdSchema = type({
	path: type("string").describe("Absolute (preferred) or session-relative directory to become the new session cwd"),
});

export type SetCwdToolInput = typeof setCwdSchema.infer;

export function setCwdFilesystemTargets(args: unknown): string[] {
	const raw = (args as Partial<SetCwdToolInput> | null)?.path;
	return typeof raw === "string" && raw.trim().length > 0 ? [raw.trim()] : [];
}

export interface SetCwdToolDetails {
	previous: string;
	cwd: string;
	requested: string;
	rulesApplied?: string[];
	rulesDropped?: string[];
	rulesUnchanged?: number;
}

export interface RuleChange {
	lines: string[];
	applied: string[];
	dropped: string[];
	unchanged: number;
}

export async function describeRuleChange(previous: string, cwd: string): Promise<RuleChange> {
	const { loadProjectContextFiles } = await import("../system-prompt");
	const [before, after] = await Promise.all([
		loadProjectContextFiles({ cwd: previous }),
		loadProjectContextFiles({ cwd }),
	]);

	const beforePaths = new Set(before.map(file => file.path));
	const afterPaths = new Set(after.map(file => file.path));
	const applied = after.filter(file => !beforePaths.has(file.path)).map(file => file.path);
	const dropped = before.filter(file => !afterPaths.has(file.path)).map(file => file.path);
	const change: RuleChange = { lines: [], applied, dropped, unchanged: after.length - applied.length };

	if (applied.length === 0 && dropped.length === 0) {
		change.lines = ["The rule files in effect are unchanged."];
		return change;
	}

	const lines: string[] = [];
	if (applied.length > 0) {
		lines.push(
			`Rule files now in effect here, which were not before: ${applied.join(", ")}. Follow them for the rest of the session.`,
		);
	}
	if (dropped.length > 0) {
		lines.push(`No longer in effect: ${dropped.join(", ")}. Stop applying them.`);
	}
	change.lines = lines;
	return change;
}
