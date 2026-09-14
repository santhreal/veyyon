import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@veyyon/utils/fs-error";
import { SESSION_FILE_EXTENSION } from "@veyyon/utils/session-file";

/** Enumerate one profile without backup recovery, writer locks or suppressed I/O errors. */
export async function sessionFiles(agentDir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(path.join(agentDir, "sessions"), { recursive: true, withFileTypes: true });
		return entries
			.filter(entry => entry.isFile() && entry.name.endsWith(SESSION_FILE_EXTENSION))
			.map(entry => path.join(entry.parentPath, entry.name));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}
