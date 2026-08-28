import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { errorMessage } from "@veyyon/utils";
import { requirePathSegment } from "../../engine/package-paths";
import { terminalBenchTaskListsDir } from "./paths";

export interface TaskSetProvenance {
	readonly marked: boolean;
	readonly biased: boolean;
	readonly note: string | null;
}

export interface LoadedTaskList {
	readonly tasks: readonly string[];
	readonly provenance: TaskSetProvenance;
	readonly path?: string;
}

/**
 * Returns the default directory containing curated Terminal-Bench task list files.
 */
export function getDefaultTaskListsDir(): string {
	return terminalBenchTaskListsDir();
}

/**
 * Parses the provenance directive from a task list file header.
 *
 * Directives:
 * - `# @biased: <note>`: indicates a biased/stress/smoke task set not suitable for headline reporting.
 * - `# @headline: <note>`: indicates an unbiased, representative headline task set.
 * - Trailing comments or text without directives are marked: false.
 */
export function parseTaskListProvenance(content: string): TaskSetProvenance {
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (!line.startsWith("#")) break;
		const body = line.replace(/^#+\s*/, "");
		const biased = body.match(/^@biased\b:?\s*(.*)$/i);
		if (biased) {
			return { marked: true, biased: true, note: biased[1]?.trim() || null };
		}
		const headline = body.match(/^@headline\b:?\s*(.*)$/i);
		if (headline) {
			return { marked: true, biased: false, note: headline[1]?.trim() || null };
		}
	}
	return { marked: false, biased: false, note: null };
}

/**
 * Parses raw task list content into task names and provenance metadata.
 * Strips comments and empty lines.
 *
 * A task list is data, and each name becomes a directory under the dataset root, so a line that is
 * not one path segment refuses the list by line number instead of reaching `path.join` and reading
 * a directory outside the corpus. `sourceLabel` names the file in that refusal.
 */
export function parseTaskList(
	content: string,
	sourceLabel = "task list",
): { tasks: readonly string[]; provenance: TaskSetProvenance } {
	const provenance = parseTaskListProvenance(content);
	const tasks: string[] = [];
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = (lines[index] ?? "").trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		try {
			tasks.push(requirePathSegment(line, "terminal-bench task id"));
		} catch (error) {
			throw new Error(`${sourceLabel} line ${index + 1}: ${errorMessage(error)}`, { cause: error });
		}
	}
	return { tasks, provenance };
}

/**
 * Loads a task list file from an explicit path or a name in the default tasks directory.
 */
export async function loadTaskList(pathOrName: string, baseDir?: string): Promise<LoadedTaskList> {
	let resolvedPath: string;
	if (isAbsolute(pathOrName)) {
		resolvedPath = pathOrName;
	} else if (pathOrName.includes("/") || pathOrName.includes("\\")) {
		resolvedPath = resolve(pathOrName);
	} else {
		const dir = baseDir ?? getDefaultTaskListsDir();
		const filename = pathOrName.endsWith(".txt") ? pathOrName : `${pathOrName}.txt`;
		resolvedPath = join(dir, filename);
	}

	const content = await readFile(resolvedPath, "utf-8");
	const { tasks, provenance } = parseTaskList(content, resolvedPath);
	return { tasks, provenance, path: resolvedPath };
}

/**
 * Lists all predefined task set names in the tasks directory.
 */
export async function listPredefinedTaskSets(tasksDir?: string): Promise<readonly string[]> {
	const dir = tasksDir ?? getDefaultTaskListsDir();
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter(e => e.isFile() && e.name.endsWith(".txt"))
			.map(e => e.name.replace(/\.txt$/, ""))
			.sort();
	} catch {
		return [];
	}
}
