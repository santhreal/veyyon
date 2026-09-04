/** Stores streamed tool-call argument JSON for live renderers and parser recovery. */
export const kStreamingPartialJson = Symbol("provider.block.partialJson");

/** Carries streamed tool-call argument JSON without exposing a string-keyed property. */
export type StreamingPartialJsonCarrier = object & { [kStreamingPartialJson]?: string };

/** Reads streamed tool-call argument JSON from a block or event snapshot. */
export function getStreamingPartialJson(block: StreamingPartialJsonCarrier | null | undefined): string | undefined {
	return block?.[kStreamingPartialJson];
}

/** Writes streamed tool-call argument JSON to a block or clears it with `undefined`. */
export function setStreamingPartialJson(block: StreamingPartialJsonCarrier, value: string | undefined): void {
	block[kStreamingPartialJson] = value;
}

/** Clears streamed tool-call argument JSON without deleting or changing object shape. */
export function clearStreamingPartialJson(block: StreamingPartialJsonCarrier): void {
	if (Object.hasOwn(block, kStreamingPartialJson)) block[kStreamingPartialJson] = undefined;
}
