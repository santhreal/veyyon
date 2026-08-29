import { type ArgotGate, makeGate } from "argot/policy";
import type { ArgotSession } from "argot/session";
import type { StreamDecoder } from "argot/stream";
import { type JsonWithOptionalFields, mapJsonStrings } from "./json-transform";

export function buildArgotGate(enabled: boolean, models: readonly string[], disableAboveTokens: number): ArgotGate {
	return makeGate(enabled, { models, disableAboveTokens });
}

export function expandToolArguments(argot: ArgotSession, args: Record<string, unknown>): Record<string, unknown> {
	if (!argot.loaded) return args;
	return mapJsonStrings(args as JsonWithOptionalFields, s => argot.expand(s)) as Record<string, unknown>;
}

export function expandSubagentReturn(codec: ArgotSession | undefined, text: string): string {
	if (!text || codec === undefined || !codec.loaded) return text;
	return codec.expand(text);
}

export function createSubagentStreamDecoder(codec: ArgotSession | undefined): StreamDecoder | undefined {
	if (codec === undefined || !codec.loaded) return undefined;
	return codec.streamDecoder();
}
