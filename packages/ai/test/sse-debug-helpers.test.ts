import { describe, expect, it } from "bun:test";
import type { RawSseEvent } from "../src/types";
import { notifyRawSseEvent, resolveOpenAiSseEventName } from "../src/utils/sse-debug";

function makeEvent(overrides: Partial<RawSseEvent> = {}): RawSseEvent {
	return {
		data: "",
		raw: [],
		...overrides,
	} as RawSseEvent;
}

describe("notifyRawSseEvent", () => {
	it("does nothing when observer is undefined", () => {
		expect(() => notifyRawSseEvent(undefined, makeEvent())).not.toThrow();
	});
	it("calls observer with event", () => {
		let received: RawSseEvent | undefined;
		notifyRawSseEvent(e => (received = e), makeEvent({ data: "test" }));
		expect(received?.data).toBe("test");
	});
	it("swallows observer errors", () => {
		expect(() =>
			notifyRawSseEvent(() => {
				throw new Error("observer error");
			}, makeEvent()),
		).not.toThrow();
	});
});

describe("resolveOpenAiSseEventName", () => {
	it("does nothing when event already has event name", () => {
		const event = makeEvent({ event: "existing", data: '{"type":"x"}' });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBe("existing");
	});
	it("does nothing when data is empty", () => {
		const event = makeEvent({ data: "" });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBeUndefined();
	});
	it("does nothing when data is [DONE]", () => {
		const event = makeEvent({ data: "[DONE]" });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBeUndefined();
	});
	it("resolves event name from type field", () => {
		const event = makeEvent({ data: '{"type":"message.start"}' });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBe("message.start");
	});
	it("resolves event name from object field when type is missing", () => {
		const event = makeEvent({ data: '{"object":"thread.message"}' });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBe("thread.message");
	});
	it("prefers type over object", () => {
		const event = makeEvent({ data: '{"type":"type_val","object":"object_val"}' });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBe("type_val");
	});
	it("does nothing when neither type nor object is a string", () => {
		const event = makeEvent({ data: '{"type":123,"object":true}' });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBeUndefined();
	});
	it("does nothing for non-object JSON", () => {
		const event = makeEvent({ data: '"just a string"' });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBeUndefined();
	});
	it("does nothing for null JSON", () => {
		const event = makeEvent({ data: "null" });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBeUndefined();
	});
	it("does nothing for invalid JSON", () => {
		const event = makeEvent({ data: "not json" });
		resolveOpenAiSseEventName(event);
		expect(event.event).toBeUndefined();
	});
	it("adds event name to raw array", () => {
		const event = makeEvent({ data: '{"type":"message.start"}', raw: ["data: ..."] });
		resolveOpenAiSseEventName(event);
		expect(event.raw[0]).toBe("event: message.start");
	});
	it("does not modify raw when no event resolved", () => {
		const event = makeEvent({ data: "not json", raw: ["data: ..."] });
		resolveOpenAiSseEventName(event);
		expect(event.raw).toEqual(["data: ..."]);
	});
});
