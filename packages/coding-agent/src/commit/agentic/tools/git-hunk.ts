import { type } from "arktype";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import * as git from "../../../utils/git";

const hunkIndexType = type("number").describe("1-based hunk index");

const gitHunkSchema = type({
	file: type("string").describe("file path"),
	"hunks?": hunkIndexType.array().atLeastLength(1),
	"staged?": type("boolean").describe("use staged changes (default true)"),
});

export function createGitHunkTool(cwd: string): CustomTool<typeof gitHunkSchema> {
	return {
		name: "git_hunk",
		label: "Git Hunk",
		description: "Return specific hunks from a file diff.",
		parameters: gitHunkSchema,
		async execute(_toolCallId, params) {
			const staged = params.staged ?? true;
			const hunks = await git.diff.hunks(cwd, [params.file], { cached: staged });
			const fileHunks = hunks.find(entry => entry.filename === params.file) ?? {
				filename: params.file,
				isBinary: false,
				hunks: [],
			};
			if (fileHunks.isBinary) {
				return {
					content: [{ type: "text", text: "Binary file diff; no hunks available." }],
					details: { file: params.file, staged, hunks: [] },
				};
			}
			const selected =
				params.hunks && params.hunks.length > 0
					? git.selectHunksByIndices(fileHunks.hunks, params.hunks)
					: fileHunks.hunks;
			const text = selected.length ? selected.map(hunk => hunk.content).join("\n\n") : "(no matching hunks)";
			return {
				content: [{ type: "text", text }],
				details: {
					file: params.file,
					staged,
					hunks: selected,
				},
			};
		},
	};
}
