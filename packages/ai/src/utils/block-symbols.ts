export const kStreamingPartialJson = Symbol("provider.block.partialJson");

export type StreamingPartialJsonCarrier = object & { [kStreamingPartialJson]?: string };

export function getStreamingPartialJson(block: StreamingPartialJsonCarrier | null | undefined): string | undefined {
	return block?.[kStreamingPartialJson];
}

export function setStreamingPartialJson(block: StreamingPartialJsonCarrier, value: string | undefined): void {
	block[kStreamingPartialJson] = value;
}

export function clearStreamingPartialJson(block: StreamingPartialJsonCarrier): void {
	if (Object.hasOwn(block, kStreamingPartialJson)) block[kStreamingPartialJson] = undefined;
}

export const kStreamingBlockIndex = Symbol("provider.block.index");

export const kStreamingLastParseLen = Symbol("provider.block.lastParseLen");

export const kStreamingArgumentsDone = Symbol("provider.block.argumentsDone");

export const kStreamingBlockKind = Symbol("provider.block.kind");

export const kCursorExecResolved = Symbol("provider.block.cursorExecResolved");

export type CursorExecResolvedCarrier = object & { [kCursorExecResolved]?: true };

export const kDemotedThinking = Symbol("provider.block.demotedThinking");

export type DemotedThinkingCarrier = object & { [kDemotedThinking]?: boolean };

export function isDemotedThinking(block: DemotedThinkingCarrier | null | undefined): boolean {
	return block?.[kDemotedThinking] === true;
}
