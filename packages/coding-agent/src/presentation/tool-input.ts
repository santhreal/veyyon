/**
 * The `input` a tool execution block states: the call's arguments as text.
 *
 * A producer builds a block for each step a streaming call reveals, each with new arguments, and the
 * card drawing it reads the arguments rather than their serialized form. A long write's arguments
 * serialize to the whole file, so a producer's block serializes `input` when it is read, once per
 * arguments object.
 */

/** What a producer keeps of the arguments its blocks last serialized. */
export interface ToolInputMemo {
	/** The arguments `input` was serialized from. */
	inputArgs: unknown;
	/** The serialized arguments, reused while the arguments are the same object. */
	input: string | undefined;
}

/** The arguments as a block states them: a string as it is, anything else as indented JSON. */
export function serializeToolInput(args: unknown): string {
	if (typeof args === "string") return args;
	if (args === undefined) return "";
	try {
		return typeof args === "object" && args !== null ? JSON.stringify(args, null, 2) : JSON.stringify(args);
	} catch {
		return "[unserializable]";
	}
}

/** Where a block holds the arguments its `input` is serialized from. */
const INPUT_ARGS: unique symbol = Symbol("tool input arguments");
/** Where a block holds its producer's memo. */
const INPUT_MEMO: unique symbol = Symbol("tool input memo");

interface LazyInputSource {
	readonly [INPUT_ARGS]: unknown;
	readonly [INPUT_MEMO]: ToolInputMemo;
}

/**
 * `input` of a block built for a producer. One function serves every block, so a transcript that keeps
 * a block keeps no closure, and no scope, of its own for it. Its sources sit in non-enumerable symbol
 * slots, which spreading, `JSON.stringify` and `structuredClone` skip.
 */
function lazyBlockInput(this: LazyInputSource): string {
	const args = this[INPUT_ARGS];
	const memo = this[INPUT_MEMO];
	if (memo.input === undefined || memo.inputArgs !== args) {
		memo.input = serializeToolInput(args);
		memo.inputArgs = args;
	}
	return memo.input;
}

const LAZY_INPUT: PropertyDescriptor = { get: lazyBlockInput, enumerable: true, configurable: true };

/** `block` with an enumerable `input` serialized from `args` through `memo` when it is read. */
export function withLazyInput<T extends object>(block: T, args: unknown, memo: ToolInputMemo): T & { input: string } {
	Object.defineProperty(block, INPUT_ARGS, { value: args });
	Object.defineProperty(block, INPUT_MEMO, { value: memo });
	return Object.defineProperty(block, "input", LAZY_INPUT) as T & { input: string };
}
