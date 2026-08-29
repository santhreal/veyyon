export interface JjCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface JjRepository {
	repoRoot: string;
	storeDir: string;
}

export interface DiffOptions {
	readonly files?: readonly string[];
	readonly nameOnly?: boolean;
	readonly signal?: AbortSignal;
}

export interface CommandOptions {
	readonly signal?: AbortSignal;
}
