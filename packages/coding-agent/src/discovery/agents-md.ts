/**
 * AGENTS.md Provider
 *
 * Discovers standalone AGENTS.md files by walking up from cwd.
 * This handles AGENTS.md files that live in project root (not in config directories
 * like .codex/ or .gemini/, which are handled by their respective providers).
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import type { LoadContext, LoadResult } from "../capability/types";
import { calculateDepth, createSourceMeta, readContextFile } from "./helpers";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md";

/**
 * Load standalone AGENTS.md files.
 *
 * Scopes: PROJECT only, walking up from cwd to the repo root (or home when the
 * cwd is not in a repo). Global and profile scope do not apply: those are
 * veyyon's own two home-level layers, resolved by the native provider from the
 * global config root and the active profile's agent dir. This provider only
 * knows the tool-neutral agents.md convention, which is a project-tree
 * convention and has no home-level or per-profile location of its own.
 */
async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// Walk up from cwd looking for AGENTS.md files
	let current = ctx.cwd;

	while (true) {
		const candidate = path.join(current, "AGENTS.md");
		const { content, warning } = await readContextFile(candidate);
		if (warning) warnings.push(warning);

		if (content !== null) {
			const parent = path.dirname(candidate);
			const baseName = parent.split(path.sep).pop() ?? "";

			if (!baseName.startsWith(".")) {
				const fileDir = path.dirname(candidate);
				const calculatedDepth = calculateDepth(ctx.cwd, fileDir, path.sep);

				items.push({
					path: candidate,
					content,
					level: "project",
					depth: calculatedDepth,
					_source: createSourceMeta(PROVIDER_ID, candidate, "project"),
				});
			}
		}

		if (current === (ctx.repoRoot ?? ctx.home)) break; // scanned repo root or home, stop

		// Move to parent directory
		const parent = path.dirname(current);
		if (parent === current) break; // Reached filesystem root
		current = parent;
	}

	return { items, warnings };
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Standalone AGENTS.md files (Codex/Gemini style)",
	priority: 10,
	load: loadAgentsMd,
});
