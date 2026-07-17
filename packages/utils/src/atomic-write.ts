import * as fs from "node:fs/promises";

/**
 * Write pretty-printed JSON via a same-directory `.tmp` file and rename, so
 * readers never observe a partial file. Handles the Windows EPERM
 * rename-over-existing case by unlinking the target first; on any other
 * failure the tmp file is cleaned up and the error rethrown.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const content = `${JSON.stringify(data, null, 2)}\n`;
	const tmpPath = `${filePath}.tmp`;
	await Bun.write(tmpPath, content);
	try {
		await fs.rename(tmpPath, filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EPERM") {
			try {
				await fs.unlink(filePath);
			} catch {
				// Target may not exist.
			}
			await fs.rename(tmpPath, filePath);
		} else {
			try {
				await fs.unlink(tmpPath);
			} catch {
				// Best effort.
			}
			throw err;
		}
	}
}
