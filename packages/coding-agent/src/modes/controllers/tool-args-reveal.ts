import type { Component } from "@veyyon/tui";
import { parseStreamingJson, parseStreamingJsonThrottled, STREAMING_JSON_PARSE_MIN_GROWTH } from "@veyyon/utils";
import type { ArgotSession } from "argot";
import { expandToolArguments } from "../../argot-wire";
import { nextStep, STREAMING_REVEAL_FRAME_MS } from "./streaming-reveal";

type ToolArgsRevealComponent = Component & {
	updateArgs(args: unknown, toolCallId?: string): void;
};

const EDIT_RENDERER_STREAMING_KEYS: readonly string[] = ["path", "file_path", "input", "_input"];

const STREAMING_STRING_KEYS_BY_TOOL: Record<string, readonly string[]> = {
	write: ["path", "file_path", "content"],
	edit: EDIT_RENDERER_STREAMING_KEYS,
	apply_patch: EDIT_RENDERER_STREAMING_KEYS,
	eval: ["code"],
	launch: ["op", "name", "application", "text", "pattern", "signal"],
};

export function streamingStringKeysForTool(toolName: string, rawInput: boolean): readonly string[] | undefined {
	if (rawInput) return undefined;
	return STREAMING_STRING_KEYS_BY_TOOL[toolName];
}

type ToolArgsRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	requestRender(component: Component): void;
};

type StreamingJsonStringExtractorResult = {
	values: Record<string, string>;
	changed: boolean;
};

function decodeJsonStringEscape(ch: string): string {
	switch (ch) {
		case '"':
		case "\\":
		case "/":
			return ch;
		case "b":
			return "\b";
		case "f":
			return "\f";
		case "n":
			return "\n";
		case "r":
			return "\r";
		case "t":
			return "\t";
		default:
			return ch;
	}
}

function isHexDigit(ch: string): boolean {
	return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

type StreamingJsonStringExtractorState = "scan" | "candidate" | "afterCandidate" | "beforeValue" | "target";

class StreamingJsonStringExtractor {
	readonly #keys: Set<string>;
	#source = "";
	#offset = 0;
	#depth = 0;
	#state: StreamingJsonStringExtractorState = "scan";
	#candidate = "";
	#candidateEscaped = false;
	#candidateUnicode = "";
	#matchedKey: string | undefined;
	#targetKey: string | undefined;
	#targetEscaped = false;
	#targetUnicode = "";
	#values: Record<string, string> = {};
	#changed = false;

	constructor(keys: readonly string[]) {
		this.#keys = new Set(keys);
	}

	reset(): void {
		this.#source = "";
		this.#offset = 0;
		this.#depth = 0;
		this.#state = "scan";
		this.#candidate = "";
		this.#candidateEscaped = false;
		this.#candidateUnicode = "";
		this.#matchedKey = undefined;
		this.#targetKey = undefined;
		this.#targetEscaped = false;
		this.#targetUnicode = "";
		this.#values = {};
		this.#changed = false;
	}

	update(prefix: string): StreamingJsonStringExtractorResult {
		if (!prefix.startsWith(this.#source)) {
			this.reset();
		}
		this.#source = prefix;
		this.#changed = false;
		while (this.#offset < prefix.length) {
			const ch = prefix[this.#offset]!;
			switch (this.#state) {
				case "scan":
					this.#scan(ch);
					break;
				case "candidate":
					this.#readCandidate(ch);
					break;
				case "afterCandidate":
					this.#afterCandidate(ch);
					break;
				case "beforeValue":
					this.#beforeValue(ch);
					break;
				case "target":
					this.#readTarget(ch);
					break;
			}
		}
		return { values: { ...this.#values }, changed: this.#changed };
	}

	#scan(ch: string): void {
		if (ch === '"') {
			this.#candidate = "";
			this.#candidateEscaped = false;
			this.#candidateUnicode = "";
			this.#state = "candidate";
		} else if (ch === "{" || ch === "[") {
			this.#depth++;
		} else if (ch === "}" || ch === "]") {
			this.#depth--;
		}
		this.#offset++;
	}

	#readCandidate(ch: string): void {
		if (this.#candidateUnicode) {
			this.#readCandidateUnicode(ch);
			return;
		}
		if (this.#candidateEscaped) {
			if (ch === "u") {
				this.#candidateUnicode = "u";
			} else {
				this.#candidate += decodeJsonStringEscape(ch);
				this.#candidateEscaped = false;
			}
			this.#offset++;
			return;
		}
		if (ch === "\\") {
			this.#candidateEscaped = true;
			this.#offset++;
			return;
		}
		if (ch === '"') {
			this.#matchedKey = this.#depth === 1 && this.#keys.has(this.#candidate) ? this.#candidate : undefined;
			this.#state = "afterCandidate";
			this.#offset++;
			return;
		}
		this.#candidate += ch;
		this.#offset++;
	}

	#readCandidateUnicode(ch: string): void {
		if (isHexDigit(ch)) {
			this.#candidateUnicode += ch;
			if (this.#candidateUnicode.length === 5) {
				this.#candidate += String.fromCharCode(Number.parseInt(this.#candidateUnicode.slice(1), 16));
				this.#candidateUnicode = "";
				this.#candidateEscaped = false;
			}
		} else {
			this.#candidate += this.#candidateUnicode + ch;
			this.#candidateUnicode = "";
			this.#candidateEscaped = false;
		}
		this.#offset++;
	}

	#afterCandidate(ch: string): void {
		if (/\s/.test(ch)) {
			this.#offset++;
			return;
		}
		const matchedKey = this.#matchedKey;
		this.#matchedKey = undefined;
		if (ch === ":" && matchedKey) {
			this.#targetKey = matchedKey;
			this.#state = "beforeValue";
			this.#offset++;
			return;
		}
		this.#state = "scan";
	}

	#beforeValue(ch: string): void {
		if (/\s/.test(ch)) {
			this.#offset++;
			return;
		}
		if (ch === '"' && this.#targetKey) {
			if (this.#values[this.#targetKey]) {
				this.#values[this.#targetKey] = "";
				this.#changed = true;
			}
			this.#targetEscaped = false;
			this.#targetUnicode = "";
			this.#state = "target";
			this.#offset++;
			return;
		}
		this.#targetKey = undefined;
		this.#state = "scan";
	}

	#readTarget(ch: string): void {
		if (this.#targetUnicode) {
			this.#readTargetUnicode(ch);
			return;
		}
		if (this.#targetEscaped) {
			if (ch === "u") {
				this.#targetUnicode = "u";
			} else {
				this.#appendTarget(decodeJsonStringEscape(ch));
				this.#targetEscaped = false;
			}
			this.#offset++;
			return;
		}
		if (ch === "\\") {
			this.#targetEscaped = true;
			this.#offset++;
			return;
		}
		if (ch === '"') {
			this.#targetKey = undefined;
			this.#state = "scan";
			this.#offset++;
			return;
		}
		this.#appendTarget(ch);
		this.#offset++;
	}

	#readTargetUnicode(ch: string): void {
		if (isHexDigit(ch)) {
			this.#targetUnicode += ch;
			if (this.#targetUnicode.length === 5) {
				this.#appendTarget(String.fromCharCode(Number.parseInt(this.#targetUnicode.slice(1), 16)));
				this.#targetUnicode = "";
				this.#targetEscaped = false;
			}
		} else {
			this.#appendTarget(this.#targetUnicode + ch);
			this.#targetUnicode = "";
			this.#targetEscaped = false;
		}
		this.#offset++;
	}

	#appendTarget(text: string): void {
		if (!this.#targetKey || text.length === 0) return;
		this.#values[this.#targetKey] = `${this.#values[this.#targetKey] ?? ""}${text}`;
		this.#changed = true;
	}
}

function createStringExtractor(keys: readonly string[] | undefined): StreamingJsonStringExtractor | undefined {
	return keys && keys.length > 0 ? new StreamingJsonStringExtractor(keys) : undefined;
}

function sameStringKeys(a: readonly string[], b: readonly string[] | undefined): boolean {
	if (a.length !== (b?.length ?? 0)) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b?.[i]) return false;
	}
	return true;
}

type RevealEntry = {
	component: ToolArgsRevealComponent | undefined;
	target: string;
	revealed: number;
	rawInput: boolean;
	exposeRawPartialJson: boolean;
	parsedArgs: Record<string, unknown>;
	parsedLen: number;
	displayArgs: Record<string, unknown>;
	displayPrefix: string;
	streamingStringKeys: readonly string[];
	stringExtractor: StreamingJsonStringExtractor | undefined;
	argot: ArgotSession | undefined;
};

function clampSliceEnd(text: string, end: number): number {
	if (end <= 0) return 0;
	if (end >= text.length) return text.length;
	const code = text.charCodeAt(end - 1);
	return code >= 0xd800 && code <= 0xdbff ? end + 1 : end;
}

type ToolArgsRevealTarget = {
	rawInput: boolean;
	exposeRawPartialJson: boolean;
	streamingStringKeys?: readonly string[];
	argot?: ArgotSession;
};

type DisplayArgsStep = {
	args: Record<string, unknown>;
	changed: boolean;
};

function initialDisplayArgs(): Record<string, unknown> {
	return { __partialJson: "" };
}

function resetDisplayState(entry: RevealEntry): void {
	entry.parsedArgs = {};
	entry.parsedLen = 0;
	entry.displayArgs = initialDisplayArgs();
	entry.displayPrefix = "";
	entry.stringExtractor?.reset();
}

function displayArgsForPrefix(entry: RevealEntry, prefix: string, forceParse = false): DisplayArgsStep {
	if (entry.rawInput) {
		if (prefix === entry.displayPrefix) return { args: entry.displayArgs, changed: false };
		const text = expandStreamedPreviewText(entry.argot, prefix);
		const args = { input: text, __partialJson: text };
		entry.displayArgs = args;
		entry.displayPrefix = prefix;
		return { args, changed: true };
	}

	let parsedChanged = false;
	if (forceParse || (prefix.length > 0 && prefix.length < STREAMING_JSON_PARSE_MIN_GROWTH)) {
		entry.parsedArgs = expandStreamedValues(entry.argot, parseStreamingJson<Record<string, unknown>>(prefix));
		entry.parsedLen = prefix.length;
		parsedChanged = true;
	} else {
		const throttled = parseStreamingJsonThrottled<Record<string, unknown>>(prefix, entry.parsedLen);
		if (throttled) {
			entry.parsedArgs = expandStreamedValues(entry.argot, throttled.value);
			entry.parsedLen = throttled.parsedLen;
			parsedChanged = true;
		}
	}
	const extracted = entry.stringExtractor?.update(prefix);
	if (extracted?.changed) {
		entry.parsedArgs = { ...entry.parsedArgs, ...expandStreamedValues(entry.argot, extracted.values) };
		parsedChanged = true;
	}

	const rawPrefixChanged = entry.exposeRawPartialJson && prefix !== entry.displayPrefix;
	if (!parsedChanged && !rawPrefixChanged) return { args: entry.displayArgs, changed: false };

	const displayPrefix = entry.exposeRawPartialJson || parsedChanged ? prefix : entry.displayPrefix;
	const args = { ...entry.parsedArgs, __partialJson: displayPrefix };
	entry.displayArgs = args;
	entry.displayPrefix = displayPrefix;
	return { args, changed: true };
}

type StreamedToolArgsSource = {
	rawInput: boolean;
	fullArgs?: Record<string, unknown>;
	streamingStringKeys?: readonly string[];
	argot?: ArgotSession;
};

function expandStreamedValues(
	argot: ArgotSession | undefined,
	values: Record<string, unknown>,
): Record<string, unknown> {
	return argot ? expandToolArguments(argot, values) : values;
}

function expandStreamedPreviewText(argot: ArgotSession | undefined, text: string): string {
	if (!argot?.loaded) return text;
	return argot.expand(text);
}

export function decodeStreamedToolArgs(partialJson: string, source: StreamedToolArgsSource): Record<string, unknown> {
	if (source.rawInput) {
		const text = expandStreamedPreviewText(source.argot, partialJson);
		return { input: text, __partialJson: text };
	}
	const parsed = expandStreamedValues(
		source.argot,
		parseStreamingJson<Record<string, unknown>>(partialJson) as Record<string, unknown>,
	);
	const args: Record<string, unknown> = source.fullArgs ? { ...source.fullArgs, ...parsed } : { ...parsed };
	const extracted = createStringExtractor(source.streamingStringKeys)?.update(partialJson);
	if (extracted) Object.assign(args, expandStreamedValues(source.argot, extracted.values));
	args.__partialJson = partialJson;
	return args;
}

export class ToolArgsRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #requestRender: (component: Component) => void;
	readonly #entries = new Map<string, RevealEntry>();
	#timer: NodeJS.Timeout | undefined;

	constructor(options: ToolArgsRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#requestRender = options.requestRender;
	}

	setTarget(id: string, partialJson: string, target: ToolArgsRevealTarget): Record<string, unknown> {
		const { rawInput, exposeRawPartialJson, streamingStringKeys, argot } = target;
		let entry = this.#entries.get(id);
		if (!entry) {
			entry = {
				component: undefined,
				target: partialJson,
				revealed: clampSliceEnd(partialJson, partialJson.length),
				rawInput,
				exposeRawPartialJson,
				parsedArgs: {},
				parsedLen: 0,
				displayArgs: initialDisplayArgs(),
				displayPrefix: "",
				streamingStringKeys: streamingStringKeys ?? [],
				stringExtractor: createStringExtractor(streamingStringKeys),
				argot,
			};
			this.#entries.set(id, entry);
		} else {
			if (
				entry.rawInput !== rawInput ||
				entry.exposeRawPartialJson !== exposeRawPartialJson ||
				!sameStringKeys(entry.streamingStringKeys, streamingStringKeys)
			) {
				entry.rawInput = rawInput;
				entry.exposeRawPartialJson = exposeRawPartialJson;
				resetDisplayState(entry);
				entry.streamingStringKeys = streamingStringKeys ?? [];
				entry.stringExtractor = createStringExtractor(streamingStringKeys);
			}
			entry.argot = argot;
			if (!partialJson.startsWith(entry.target)) {
				entry.revealed = Math.min(entry.revealed, partialJson.length);
				resetDisplayState(entry);
			}
			entry.target = partialJson;
		}
		if (!this.#getSmoothStreaming()) entry.revealed = entry.target.length;
		entry.revealed = clampSliceEnd(entry.target, entry.revealed);
		this.#syncTimer();
		return displayArgsForPrefix(entry, entry.target.slice(0, entry.revealed)).args;
	}

	bind(id: string, component: ToolArgsRevealComponent): void {
		const entry = this.#entries.get(id);
		if (entry) entry.component = component;
	}

	finish(id: string): void {
		this.#entries.delete(id);
		if (this.#entries.size === 0) this.#stopTimer();
	}

	flushAll(): void {
		for (const [id, entry] of this.#entries) {
			if (entry.component && entry.revealed < entry.target.length) {
				entry.component.updateArgs(displayArgsForPrefix(entry, entry.target, true).args, id);
			}
		}
		this.#entries.clear();
		this.#stopTimer();
	}

	stop(): void {
		this.#entries.clear();
		this.#stopTimer();
	}

	#syncTimer(): void {
		for (const entry of this.#entries.values()) {
			if (entry.revealed < entry.target.length) {
				this.#startTimer();
				return;
			}
		}
		this.#stopTimer();
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick();
		}, STREAMING_REVEAL_FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		let advanced = false;
		const rendered = new Set<ToolArgsRevealComponent>();
		for (const [id, entry] of this.#entries) {
			const backlog = entry.target.length - entry.revealed;
			if (backlog <= 0 || !entry.component) continue;
			entry.revealed = clampSliceEnd(entry.target, entry.revealed + nextStep(backlog));
			const display = displayArgsForPrefix(entry, entry.target.slice(0, entry.revealed));
			if (display.changed) {
				entry.component.updateArgs(display.args, id);
				rendered.add(entry.component);
			}
			advanced = true;
		}
		if (advanced) {
			for (const component of rendered) this.#requestRender(component);
		} else {
			this.#stopTimer();
		}
	}
}
