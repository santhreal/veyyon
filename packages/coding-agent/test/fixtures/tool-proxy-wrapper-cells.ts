/**
 * The cells each wrapper forwarding a tool leaves live, counted by type in the process that runs this
 * file. The test imports the constants. Run as a script, it prints, as JSON, the live `Function`,
 * `JSLexicalEnvironment` and `GetterSetter` cells per wrapper while `WRAPPERS` wrappers stay
 * referenced, for two arms: `applyToolProxy`, and `perKeyClosures`, which defines one closure getter
 * per key the way a forwarding wrapper did before the accessors were shared. It also prints the
 * `Function` cells left per wrapper once wrappers of tools with a symbol key of their own are dropped.
 */
import { heapStats } from "bun:jsc";
import { applyToolProxy } from "@veyyon/kernel/registry/tool-proxy";

export const WRAPPERS = 2000;

export interface CellsPerWrapper {
	Function: number;
	JSLexicalEnvironment: number;
	GetterSetter: number;
}

export interface WrapperCells {
	/** Keys each wrapper forwards. */
	keys: number;
	applyToolProxy: CellsPerWrapper;
	perKeyClosures: CellsPerWrapper;
	/** `Function` cells left per dropped wrapper whose tool had a symbol key of its own. */
	droppedSymbolKeyFunctions: number;
}

const kMarker = Symbol("tool-proxy-fixture.marker");

/** A tool shaped like the ones the agent wraps: data fields, a symbol key and prototype methods. */
class Tool {
	name = "read";
	label = "Read";
	description = "Reads a file.";
	parameters = { type: "object" };
	strict = true;
	approval = "read";
	loadMode = "essential";
	summary = "Read files";
	[kMarker] = true;
	execute(): string {
		return this.name;
	}
	renderCall(): string {
		return this.label;
	}
	renderResult(): string {
		return this.summary;
	}
}

const TOOL = new Tool();

/** Every key `applyToolProxy` forwards from {@link TOOL}: own and inherited, without `constructor`. */
function forwardedKeys(): PropertyKey[] {
	const keys: PropertyKey[] = [...Reflect.ownKeys(TOOL)];
	for (const key of Reflect.ownKeys(Tool.prototype)) if (key !== "constructor") keys.push(key);
	return keys;
}

function perKeyClosures(tool: object, wrapper: object): void {
	for (const key of forwardedKeys()) {
		Object.defineProperty(wrapper, key, {
			get() {
				const value = (tool as Record<PropertyKey, unknown>)[key];
				return typeof value === "function" ? value.bind(tool) : value;
			},
			enumerable: true,
			configurable: true,
		});
	}
}

function counts(): CellsPerWrapper {
	Bun.gc(true);
	const types = heapStats().objectTypeCounts;
	return {
		Function: types.Function ?? 0,
		JSLexicalEnvironment: types.JSLexicalEnvironment ?? 0,
		GetterSetter: types.GetterSetter ?? 0,
	};
}

/**
 * Cells per wrapper left live while {@link WRAPPERS} wrappers built by `forward` stay referenced. A
 * discarded pass first takes every first-call cache out of the baseline, and each held wrapper is
 * read through so the arm is known to forward.
 */
function cellsPerWrapper(forward: (tool: object, wrapper: object) => void): CellsPerWrapper {
	for (let i = 0; i < WRAPPERS; i++) forward(TOOL, {});
	const before = counts();
	const held: Record<PropertyKey, unknown>[] = [];
	for (let i = 0; i < WRAPPERS; i++) {
		const wrapper: Record<PropertyKey, unknown> = {};
		forward(TOOL, wrapper);
		held.push(wrapper);
	}
	const after = counts();
	for (const wrapper of held) {
		if (wrapper.description !== TOOL.description || wrapper[kMarker] !== true) {
			throw new Error("a wrapper does not forward the tool's fields");
		}
	}
	return {
		Function: (after.Function - before.Function) / WRAPPERS,
		JSLexicalEnvironment: (after.JSLexicalEnvironment - before.JSLexicalEnvironment) / WRAPPERS,
		GetterSetter: (after.GetterSetter - before.GetterSetter) / WRAPPERS,
	};
}

/**
 * `Function` cells left live per wrapper after {@link WRAPPERS} tools, each with a symbol key of its
 * own, are wrapped and every tool, wrapper and symbol is dropped.
 */
function functionsPerDroppedSymbolKey(): number {
	const before = counts().Function;
	for (let i = 0; i < WRAPPERS; i++) {
		const key = Symbol(`own-${i}`);
		const wrapper: Record<PropertyKey, unknown> = {};
		applyToolProxy({ [key]: i }, wrapper);
		if (wrapper[key] !== i) throw new Error("a wrapper does not forward its symbol key");
	}
	return (counts().Function - before) / WRAPPERS;
}

export function measure(): WrapperCells {
	return {
		keys: forwardedKeys().length,
		applyToolProxy: cellsPerWrapper(applyToolProxy),
		perKeyClosures: cellsPerWrapper(perKeyClosures),
		droppedSymbolKeyFunctions: functionsPerDroppedSymbolKey(),
	};
}

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(measure())}\n`);
}
