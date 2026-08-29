import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@veyyon/utils/fs-error";

export const BYTES_PER_GB = 1024 ** 3;

export type SpawnedWriteSource = "io.stat" | "proc-io" | "none";

export function parseIoStatWrittenBytes(text: string): number | undefined {
	let total: number | undefined;
	for (const line of text.split("\n")) {
		for (const field of line.trim().split(/\s+/)) {
			const separator = field.indexOf("=");
			if (separator < 0 || field.slice(0, separator) !== "wbytes") continue;
			const bytes = Number.parseInt(field.slice(separator + 1), 10);
			if (!Number.isFinite(bytes) || bytes < 0) continue;
			total = (total ?? 0) + bytes;
		}
	}
	return total;
}

export function parseProcIoWrittenBytes(text: string): number | undefined {
	for (const line of text.split("\n")) {
		if (!line.startsWith("write_bytes:")) continue;
		const bytes = Number.parseInt(line.slice("write_bytes:".length).trim(), 10);
		return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
	}
	return undefined;
}

export interface SpawnedWriteSample {
	source: SpawnedWriteSource;
	ioStatBytes?: number;
	procIo?: Array<{ pid: number; bytes: number }>;
}

export async function readOptionalFile(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		return undefined;
	}
}

export async function sampleSpawnedWrites(options: {
	cgroupDir: string | undefined;
	procRoot: string;
	members: number[];
}): Promise<SpawnedWriteSample> {
	if (options.cgroupDir) {
		const text = await readOptionalFile(path.join(options.cgroupDir, "io.stat"));
		const ioStatBytes = text === undefined ? undefined : parseIoStatWrittenBytes(text);
		if (ioStatBytes !== undefined) return { source: "io.stat", ioStatBytes };
	}
	const procIo: Array<{ pid: number; bytes: number }> = [];
	for (const pid of options.members) {
		const text = await readOptionalFile(path.join(options.procRoot, String(pid), "io"));
		if (text === undefined) continue;
		const bytes = parseProcIoWrittenBytes(text);
		if (bytes !== undefined) procIo.push({ pid, bytes });
	}
	if (procIo.length > 0) return { source: "proc-io", procIo };
	const procRootReadable = await readOptionalFile(path.join(options.procRoot, "self", "io"));
	return procRootReadable === undefined ? { source: "none" } : { source: "proc-io", procIo };
}
