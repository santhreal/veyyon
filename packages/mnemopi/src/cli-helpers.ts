import type { BeamMemory } from "./core/beam";

export interface CliIo {
	write(data: string): void;
}

export interface CliContext {
	readonly dataDir?: string;
	readonly dbPath?: string;
	readonly memory?: BeamMemory;
	readonly createMemory?: () => BeamMemory;
	readonly stdout?: CliIo;
	readonly stderr?: CliIo;
}
