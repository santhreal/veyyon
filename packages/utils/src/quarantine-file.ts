import * as fsSync from "node:fs";
import * as logger from "./logger";

export interface QuarantinedFile {
	path: string;
	quarantinePath: string;
}

export function quarantinePathFor(filePath: string): string {
	return `${filePath}.corrupt`;
}

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
