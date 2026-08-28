import { ptree } from "@veyyon/utils";

export interface ExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
	adoptPid?: (pid: number) => void;
	beforeSpawn?: () => Promise<void>;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	await options?.beforeSpawn?.();
	const result = await ptree.exec([command, ...args], {
		cwd,
		signal: options?.signal,
		timeout: options?.timeout,
		onSpawnPid: options?.adoptPid,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.exitCode ?? 0,
		killed: Boolean(result.exitError?.aborted),
	};
}

export function withSessionCpuExec(
	options: ExecOptions | undefined,
	adoptPid: ((pid: number) => void) | undefined,
	gate: ((what: string) => Promise<void>) | undefined,
	what: string,
): ExecOptions | undefined {
	if (!adoptPid && !gate) return options;
	const priorSpawn = options?.beforeSpawn;
	const priorAdopt = options?.adoptPid;
	return {
		...options,
		...(adoptPid || priorAdopt
			? {
					adoptPid: (pid: number) => {
						adoptPid?.(pid);
						priorAdopt?.(pid);
					},
				}
			: {}),
		...(gate || priorSpawn
			? {
					beforeSpawn: async () => {
						if (gate) await gate(what);
						await priorSpawn?.();
					},
				}
			: {}),
	};
}
