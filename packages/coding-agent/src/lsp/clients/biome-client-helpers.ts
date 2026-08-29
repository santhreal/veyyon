import { errorMessage, logger, readPipeText } from "@veyyon/utils";
import type { DiagnosticSeverity } from "../../lsp/types";
import { adoptIntoPrimarySessionCpuBudget } from "../../session/cpu-limit";

export interface BiomeJsonOutput {
	diagnostics: BiomeDiagnostic[];
}

export interface BiomeDiagnostic {
	category: string; // e.g., "lint/correctness/noUnusedVariables"
	severity: "error" | "warning" | "info" | "hint";
	description: string;
	location?: {
		path?: { file: string };
		span?: [number, number]; // [startOffset, endOffset] in bytes
		sourceCode?: string;
	};
}

export function offsetsToPositions(source: string, offsets: number[]): Map<number, { line: number; column: number }> {
	const sorted = Array.from(new Set(offsets)).sort((a, b) => a - b);
	const result = new Map<number, { line: number; column: number }>();
	let line = 1;
	let column = 1;
	let byteIndex = 0;
	let next = 0;

	for (const ch of source) {
		if (next >= sorted.length) break;
		const cp = ch.codePointAt(0) as number;
		const byteLen = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
		while (next < sorted.length && byteIndex + byteLen > sorted[next]) {
			result.set(sorted[next], { line, column });
			next++;
		}
		if (ch === "\n") {
			line++;
			column = 1;
		} else {
			column++;
		}
		byteIndex += byteLen;
	}

	while (next < sorted.length) {
		result.set(sorted[next], { line, column });
		next++;
	}

	return result;
}

export function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "info":
			return 3;
		case "hint":
			return 4;
		default:
			return 2;
	}
}

export async function runBiome(
	args: string[],
	cwd: string,
	resolvedCommand?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const command = resolvedCommand ?? "biome";

	try {
		const proc = Bun.spawn([command, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		adoptIntoPrimarySessionCpuBudget(proc.pid);

		const [stdout, stderr] = await Promise.all([readPipeText(proc.stdout), readPipeText(proc.stderr)]);
		const exitCode = await proc.exited;

		return { stdout, stderr, success: exitCode === 0 };
	} catch (err) {
		return { stdout: "", stderr: errorMessage(err), success: false };
	}
}

export const reportedBiomeFailures = new Set<string>();

export function warnBiomeOnce(key: string, message: string, meta: Record<string, unknown>): void {
	if (reportedBiomeFailures.has(key)) return;
	reportedBiomeFailures.add(key);
	logger.warn(message, meta);
}
