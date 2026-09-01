import type { Tool } from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";

export interface StablePrefixSnapshot {
	systemPrompt: string[];
	tools: Tool[];
	fingerprint: string;
}

export interface BuildOptions {
	intentTracing: boolean;
	exampleDialect?: Dialect;
	pruneToolDescriptions?: boolean;
}
