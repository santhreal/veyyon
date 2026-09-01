import { errorMessage, readPipeText } from "@veyyon/utils";
import type { DiagnosticSeverity } from "../../lsp/types";
import { adoptIntoPrimarySessionCpuBudget } from "../../session/cpu-limit";

export interface SwiftLintViolation {
	character: number;
	file: string;
	line: number;
	reason: string;
	rule_id: string;
	severity: "Error" | "Warning";
	type: string;
}

export function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "Error":
			return 1;
		case "Warning":
			return 2;
		default:
			return 2;
	}
}

export async function runSwiftLint(
	args: string[],
	cwd: string,
	resolvedCommand?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const command = resolvedCommand ?? "swiftlint";

	try {
		const proc = Bun.spawn([command, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		adoptIntoPrimarySessionCpuBudget(proc.pid);

		const [stdout, stderr] = await Promise.all([readPipeText(proc.stdout), readPipeText(proc.stderr)]);
		await proc.exited;

		return { stdout, stderr, success: stdout.length > 0 };
	} catch (err) {
		return { stdout: "", stderr: errorMessage(err), success: false };
	}
}
