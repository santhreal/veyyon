/**
 * arktype, evaluated on first use.
 *
 * Evaluating the `arktype` package builds its keyword scopes: 115 modules, about 30ms of a compiled
 * binary's launch and 6 MiB of heap. Every schema in this tree is built inside a `lazy()` thunk, so a
 * launch reads none of it before the first schema is needed, and a static import of the package still
 * evaluated all of it with the module graph, ahead of the first frame.
 *
 * Shipped source imports the arktype values it calls from this module. `type`, `scope` and `Type` are
 * stand-ins: calling one, constructing one or reading a property of one evaluates arktype and forwards to
 * the real value, so `type({...})`, `type.enumerated(...)` and `x instanceof type.errors` behave as they
 * do on the package's own exports. A type-only import of `"arktype"` evaluates nothing and stays.
 */
import type * as ArkType from "arktype";
import type * as ArkTypeConfig from "arktype/config";

let loaded: typeof ArkType | undefined;
/** Each configuration {@link configureArktype} received before the package evaluated, in call order. */
const pendingConfigs: ArkTypeConfig.ArkConfig[] = [];

/** The `arktype` module namespace. The first call applies the held configuration and evaluates the package. */
export function loadArktype(): typeof ArkType {
	if (loaded) return loaded;
	for (const config of pendingConfigs) applyConfig(config);
	pendingConfigs.length = 0;
	// `require`, because no deferred `import` form survives the binary build: `bun build --compile` (Bun
	// 1.4.0) evaluates an `import defer` namespace with the rest of the graph, and `await import()` cannot
	// answer a synchronous `type(...)` call. `arktype` publishes one ESM entry, so the bundle holds one copy.
	loaded = require("arktype") as typeof ArkType;
	return loaded;
}

/**
 * Apply `config` to arktype's global configuration. The package reads it when it evaluates, so before
 * the first {@link loadArktype} the configuration is held and applied by that call, and nothing
 * evaluates now: the configuration entry alone is 32 modules. After it, the configuration applies at once.
 */
export function configureArktype(config: ArkTypeConfig.ArkConfig): void {
	if (loaded) applyConfig(config);
	else pendingConfigs.push(config);
}

function applyConfig(config: ArkTypeConfig.ArkConfig): void {
	(require("arktype/config") as typeof ArkTypeConfig).configure(config);
}

/**
 * The installed ArkType release, read from the package's `package.json`. Evaluates no ArkType module,
 * so a caller can key a cache on the release without building a schema. `arktype` pins `@ark/schema`
 * and `@ark/util` to exact versions, so the release identifies the schema implementation.
 */
export function arktypeRelease(): string {
	// `require`, because the package's `exports` map omits `./package.json`, so a typed `import` does not
	// resolve; Bun resolves the path and the binary build inlines the JSON.
	const { version } = require("arktype/package.json") as { version?: unknown };
	if (typeof version !== "string") throw new Error("arktype/package.json has no version string");
	return version;
}

type Forwardable = (...args: unknown[]) => unknown;

/**
 * A function standing in for the value `resolve` returns. A call, a `new` and a property read are
 * forwarded to that value; other reflection (`Object.keys`, `in`, `Object.getPrototypeOf`) reads the
 * stand-in itself.
 */
function standIn<T extends object>(resolve: () => T): T {
	const handler: ProxyHandler<Forwardable> = {
		apply: (_target, thisArg, args) => Reflect.apply(resolve() as Forwardable, thisArg, args),
		construct: (_target, args) => Reflect.construct(resolve() as Forwardable, args),
		get: (_target, key) => Reflect.get(resolve(), key),
	};
	// biome-ignore lint/complexity/useArrowFunction: an arrow function cannot be constructed, so `new Type(...)` would throw before the trap
	return new Proxy<Forwardable>(function () {}, handler) as unknown as T;
}

export const type: typeof ArkType.type = standIn(() => loadArktype().type);
export const scope: typeof ArkType.scope = standIn(() => loadArktype().scope);
export const Type: typeof ArkType.Type = standIn(() => loadArktype().Type);
