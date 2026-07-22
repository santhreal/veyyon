import * as fsSync from "node:fs";
import * as logger from "./logger";

/** A config file that failed to parse, and where its bytes were preserved. */
export interface QuarantinedFile {
	/** The file that could not be parsed. */
	path: string;
	/** Where its original contents were copied so they are not lost. */
	quarantinePath: string;
}

/** Where the preserved copy of `filePath` lives. */
export function quarantinePathFor(filePath: string): string {
	return `${filePath}.corrupt`;
}

/**
 * Preserve a config file we could not parse, before anything writes over it.
 *
 * A config file becomes unparseable in ordinary use: a hand-edited value with an
 * unquoted colon, a bad indent, or a half-written file left by a crash or a full
 * disk. The dangerous part is what happens next. A loader that answers "empty"
 * hands the caller a blank config, and the next save writes that blank config
 * plus one changed key back over the file, permanently erasing everything else
 * the user had. It fires at exactly the moment they are most likely to be fixing
 * the file by hand.
 *
 * Copying the bytes aside first means the save can proceed normally and nothing
 * is lost either way: the session keeps the change the user just made, and the
 * old config stays readable next to the new file. Refusing to save instead would
 * only trade one silent failure for another, where a setting appears to apply
 * and is gone on the next launch.
 *
 * The copy is written once per file. On a later save the live file is valid
 * again, and overwriting the rescued copy with it would discard the only
 * remaining record of what the user had.
 *
 * Returns where the user's bytes are, which the caller should show them, and
 * `undefined` only when nothing could be preserved. It always logs at error
 * level, because the caller is about to behave as though the file were empty and
 * that is not something to discover later.
 *
 * ```ts
 * try {
 *   return YAML.parse(content);
 * } catch (error) {
 *   await quarantineUnparseableFile(filePath, content, error);
 *   return {};
 * }
 * ```
 */
export async function quarantineUnparseableFile(
	filePath: string,
	content: string,
	error: unknown,
): Promise<string | undefined> {
	const quarantinePath = quarantinePathFor(filePath);
	try {
		const existed = await Bun.file(quarantinePath).exists();
		if (!existed) await Bun.write(quarantinePath, content);
		return report(filePath, quarantinePath, existed ? "existing" : "written", error);
	} catch (writeError) {
		logFailedPreserve(filePath, quarantinePath, writeError);
		return report(filePath, quarantinePath, "failed", error);
	}
}

/**
 * Synchronous twin of {@link quarantineUnparseableFile}, for loaders that read
 * with `fs.readFileSync` and cannot await.
 */
export function quarantineUnparseableFileSync(filePath: string, content: string, error: unknown): string | undefined {
	const quarantinePath = quarantinePathFor(filePath);
	try {
		const existed = fsSync.existsSync(quarantinePath);
		if (!existed) fsSync.writeFileSync(quarantinePath, content);
		return report(filePath, quarantinePath, existed ? "existing" : "written", error);
	} catch (writeError) {
		logFailedPreserve(filePath, quarantinePath, writeError);
		return report(filePath, quarantinePath, "failed", error);
	}
}

type PreserveOutcome = "written" | "existing" | "failed";

function logFailedPreserve(filePath: string, quarantinePath: string, writeError: unknown): void {
	logger.error("Could not preserve an unparseable config file", {
		path: filePath,
		quarantinePath,
		error: String(writeError),
	});
}

function report(
	filePath: string,
	quarantinePath: string,
	outcome: PreserveOutcome,
	error: unknown,
): string | undefined {
	logger.error("Config file could not be parsed and was ignored", {
		path: filePath,
		error: String(error),
		...(outcome === "failed"
			? { note: "The original contents could not be preserved" }
			: outcome === "existing"
				? { note: `An earlier copy is already at ${quarantinePath}; this one was not overwritten` }
				: { preservedAt: quarantinePath }),
	});
	return outcome === "failed" ? undefined : quarantinePath;
}
