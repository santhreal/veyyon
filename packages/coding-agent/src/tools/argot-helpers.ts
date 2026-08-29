import { type } from "arktype";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

export const folderSchema = type({
	folder_path: type("string").describe(
		"Absolute (preferred) or session-relative path to the folder to load. Argot resolves it to the nearest project it belongs to (its .git or .argot marker), never a parent that contains many projects.",
	),
});

export type ArgotFolderInput = typeof folderSchema.infer;

export interface ArgotLoadDetails {
	root: string;
	handles: number;
	requested: string;
}

export interface ArgotUnloadDetails {
	root: string;
	changed: boolean;
	requested: string;
}

export type ArgotSession = NonNullable<ReturnType<NonNullable<ToolSession["getArgotSession"]>>>;

export function requireArgot(session: ToolSession): ArgotSession {
	const argot = session.getArgotSession?.();
	if (argot === undefined) {
		throw new ToolError(
			"Argot shorthand is not enabled for this session, so there is nothing to load. Enable it with the `argot.enabled` setting.",
		);
	}
	return argot;
}
