/** The tool each wrapper forwards to. */
const FORWARDED = new WeakMap<object, object>();

/**
 * The accessor for each forwarded key, shared by every wrapper that forwards that key: string and
 * registered-symbol keys here, and a non-registered symbol key in {@link SYMBOL_ACCESSORS}, which
 * lets its accessor go with the symbol.
 */
const ACCESSORS = new Map<string | symbol, PropertyDescriptor>();
const SYMBOL_ACCESSORS = new WeakMap<symbol, PropertyDescriptor>();

/** The tool `receiver` forwards to: its own, or that of the nearest wrapper on its prototype chain. */
function forwardedTool(receiver: object, key: PropertyKey): object {
	for (let at: object | null = receiver; at !== null; at = Object.getPrototypeOf(at)) {
		const tool = FORWARDED.get(at);
		if (tool !== undefined) return tool;
	}
	throw new TypeError(`Tool proxy property ${String(key)} was read from an object that forwards to no tool`);
}

function accessorFor(key: string | symbol): PropertyDescriptor {
	const weak = typeof key === "symbol" && Symbol.keyFor(key) === undefined;
	let accessor = weak ? SYMBOL_ACCESSORS.get(key) : ACCESSORS.get(key);
	if (accessor === undefined) {
		accessor = {
			get(this: object): unknown {
				const tool = forwardedTool(this, key);
				const value = (tool as Record<PropertyKey, unknown>)[key];
				// Bind real methods so `this` is preserved through the wrapper, but leave
				// callable values that aren't plain functions untouched — notably an ArkType
				// `Type` (the `parameters` schema) is callable yet lacks `Function.prototype.bind`.
				return typeof value === "function" && typeof value.bind === "function" ? value.bind(tool) : value;
			},
			enumerable: true,
			configurable: true,
		};
		if (weak) SYMBOL_ACCESSORS.set(key, accessor);
		else ACCESSORS.set(key, accessor);
	}
	return accessor;
}

/**
 * Defines lazy proxy properties on a wrapper so it forwards to the underlying tool: every own and
 * inherited key of `tool` the wrapper does not have, except `constructor`, reads `tool` at access
 * time. The accessors are shared across wrappers, so a wrapper holds no closure per key. A wrapper
 * forwards to one tool; applying a second tool to it throws.
 */
export function applyToolProxy<TTool extends object>(tool: TTool, wrapper: object): void {
	const previous = FORWARDED.get(wrapper);
	if (previous !== undefined && previous !== tool) {
		throw new TypeError("applyToolProxy: the wrapper already forwards to another tool");
	}
	FORWARDED.set(wrapper, tool);
	const visited = new Set<PropertyKey>();
	let current: object | null = tool;

	while (current && current !== Object.prototype) {
		for (const key of Reflect.ownKeys(current)) {
			if (key === "constructor" || visited.has(key) || key in wrapper) {
				continue;
			}
			visited.add(key);
			Object.defineProperty(wrapper, key, accessorFor(key));
		}
		current = Object.getPrototypeOf(current);
	}
}
