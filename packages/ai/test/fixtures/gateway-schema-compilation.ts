/**
 * Prints as JSON, from a process configured ArkType jitless as the CLI entry configures it,
 * whether a schema built with the gateway parser was compiled and which exported ArkType types of
 * each gateway schema module were compiled. A type built with `arktype`'s own `type` in the same
 * process is the control that shows the process is jitless.
 *
 * Run as its own process: ArkType reads the jitless setting when `arktype` first evaluates, so a
 * test process that already loaded it cannot observe the setting.
 */
import "./arktype-jitless";
import { type } from "arktype";
import * as anthropicMessages from "../../src/providers/anthropic-messages-server-schema";
import { type as gatewayType } from "../../src/providers/gateway-schema-type";
import * as openaiChat from "../../src/providers/openai-chat-server-schema";
import * as openaiResponses from "../../src/providers/openai-responses-server-schema";

export interface GatewayCompilationReport {
	control: boolean;
	parser: boolean;
	/** Compiled verdict per exported ArkType type, keyed by module file name. */
	modules: Record<string, Record<string, boolean>>;
}

interface ArkTypeNode {
	internal: { kind: string; precompilation?: string };
}

/** An exported ArkType type: a callable whose `internal` node, itself callable, has a kind. */
function isArkType(value: unknown): value is ArkTypeNode {
	if (typeof value !== "function") return false;
	const internal: unknown = Reflect.get(value, "internal");
	return typeof internal === "function" && typeof Reflect.get(internal, "kind") === "string";
}

function compiledExports(exports: Record<string, unknown>): Record<string, boolean> {
	const compiled: Record<string, boolean> = {};
	for (const [name, value] of Object.entries(exports)) {
		if (isArkType(value)) compiled[name] = value.internal.precompilation !== undefined;
	}
	return compiled;
}

const SAMPLE = { role: "'user'", content: "string" } as const;

const report: GatewayCompilationReport = {
	control: type(SAMPLE).internal.precompilation !== undefined,
	parser: gatewayType(SAMPLE).internal.precompilation !== undefined,
	modules: {
		"anthropic-messages-server-schema.ts": compiledExports(anthropicMessages),
		"openai-chat-server-schema.ts": compiledExports(openaiChat),
		"openai-responses-server-schema.ts": compiledExports(openaiResponses),
	},
};

process.stdout.write(JSON.stringify(report));
