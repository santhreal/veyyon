import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import type { LazyStreamLimits } from "@veyyon/ai/providers/register-builtins";
import * as registerBuiltins from "@veyyon/ai/providers/register-builtins";
import { iterateWithIdleTimeout } from "@veyyon/ai/utils/idle-iterator";

/**
 * Class lock: every lazily-registered provider has a RECORDED decision about its
 * stream watchdog, that decision matches the budget the code actually resolves,
 * and every budget that relies on the shared watchdog TERMINATES a stream a
 * wedged local tool is holding silent.
 *
 * `register-builtins.ts` wraps each provider stream in `iterateWithIdleTimeout`
 * with the budget `resolveLazyStreamBudget` returns. A registration that passes
 * no limits inherits finite generic defaults. A registration that passes
 * `providerHandlesStreamTimeouts: true` gets `{ idleTimeoutMs: undefined,
 * firstItemTimeoutMs: 0 }` — no shared watchdog at all — on the promise that the
 * provider module arms its own. Nothing checked either half. That is why
 * `streamGoogle` / `streamGoogleVertex` read as unguarded to anyone auditing the
 * file (they are in fact on the finite generic defaults), and it is why a new
 * provider could ship with the opt-out and no watchdog anywhere: a silent stream
 * that only a user cancel ends, which is #4593's failure mode by construction.
 *
 * How the class is closed rather than the case:
 *
 *   - The member list is derived at run time from the module's own exports and
 *     from the source registrations, never hardcoded.
 *   - {@link WATCHDOG_DECISIONS} must name EVERY provider. Add a provider and
 *     this file goes red until its decision is recorded, including a provider
 *     that quietly inherits the generic defaults.
 *   - Each recorded decision is checked against the resolved budget, so the
 *     register cannot lie about what the code does.
 *   - Termination is asserted per provider, in both watchdog phases (before the
 *     first item and mid-stream), against a local-work predicate that never goes
 *     false. A budget that cannot end such a stream fails with "did not
 *     terminate" instead of hanging the suite.
 *
 * LIMIT, stated plainly: for an opted-out provider this asserts the module ARMS
 * a watchdog, not that every path through it is covered. Per-provider timeout
 * behaviour is proved by that provider's own tests; this lock exists so no
 * provider can skip having one.
 */

const PROVIDERS_DIR = path.resolve(import.meta.dirname, "..", "src", "providers");
const REGISTER_BUILTINS = path.join(PROVIDERS_DIR, "register-builtins.ts");

/**
 * What a provider relies on to end a stream that has gone quiet.
 *
 * - `shared-generic-defaults`: the wrapper's global budget, unmodified.
 * - `shared-widened-budget`: the wrapper's budget, widened for a transport whose
 *   healthy gaps outlast the global default.
 * - `shared-openai-env-precedence`: the global budget's VALUES, but the
 *   OpenAI-family env knobs win over the generic ones. Writing this out is what
 *   surfaced that `OPENAI_IDLE_FLOORED_LAZY_STREAM_LIMITS` widens nothing by
 *   itself: with no env set, ollama runs the same numbers as bedrock.
 * - `provider-owned`: the wrapper stands down entirely and the provider module
 *   arms `iterateWithIdleTimeout` itself.
 */
type WatchdogDecision =
	| "shared-generic-defaults"
	| "shared-widened-budget"
	| "shared-openai-env-precedence"
	| "provider-owned";

/**
 * The decision on record for every registered provider. This list is the gate:
 * it must equal the module's stream exports exactly, so a new provider turns
 * this file red until someone writes down what ends its streams. Do not add a
 * row to make a failure go away — the row is checked against the budget the
 * code resolves, and a wrong row fails differently.
 */
const WATCHDOG_DECISIONS: Record<string, WatchdogDecision> = {
	streamAnthropic: "provider-owned",
	streamAzureOpenAIResponses: "provider-owned",
	streamBedrock: "shared-generic-defaults",
	streamCursor: "shared-widened-budget",
	streamDevin: "shared-widened-budget",
	streamGoogle: "shared-generic-defaults",
	streamGoogleGeminiCli: "shared-widened-budget",
	streamGoogleVertex: "shared-generic-defaults",
	streamOllama: "shared-openai-env-precedence",
	streamOpenAICodexResponses: "provider-owned",
	streamOpenAICompletions: "provider-owned",
	streamOpenAIResponses: "provider-owned",
};

/**
 * Every field of `LazyStreamLimits` and the literal kind it is written with.
 * Adding a field to the interface fails to typecheck here until it is listed,
 * which is the point: a new knob that changes the budget must be considered by
 * this lock before it can be used.
 */
const LIMITS_FIELD_KINDS: Record<keyof LazyStreamLimits, "number" | "boolean"> = {
	defaultFirstEventTimeoutMs: "number",
	defaultIdleTimeoutMs: "number",
	providerHandlesStreamTimeouts: "boolean",
	openAIIdleEnvFloorsFirstEvent: "boolean",
};

/** One `export const streamX = createLazyStream(api, loader, LIMITS?)` registration. */
interface Registration {
	streamExport: string;
	api: string;
	moduleName: string;
	limitsName: string | undefined;
	limits: LazyStreamLimits | undefined;
}

const ENV_KEYS = [
	"VEYYON_STREAM_IDLE_TIMEOUT_MS",
	"VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS",
	"VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS",
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

// An operator may legitimately disable the watchdog through these; the lock is
// about what the CODE decides, so it runs with the knobs unset and restores them.
beforeEach(() => {
	for (const key of ENV_KEYS) {
		originalEnv[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = originalEnv[key];
		if (prior === undefined) delete Bun.env[key];
		else Bun.env[key] = prior;
	}
	vi.useRealTimers();
});

function extractImportPathFromFactory(node: t.Node): string {
	const importPaths: string[] = [];

	t.traverseFast(node, n => {
		if (t.isCallExpression(n) && t.isImport(n.callee)) {
			const firstArg = n.arguments[0];
			if (t.isStringLiteral(firstArg)) {
				importPaths.push(firstArg.value);
			} else {
				throw new Error("Dynamic import argument must be a string literal");
			}
		}
	});
	if (importPaths.length === 0) {
		throw new Error("Could not find dynamic import('./...') in factory function");
	}
	if (importPaths.length > 1) {
		throw new Error(`Expected exactly one dynamic import, found ${importPaths.length}`);
	}
	return importPaths[0].replace(/^\.\//, "");
}

const source = await fs.readFile(REGISTER_BUILTINS, "utf8");
const ast = parse(source, {
	sourceType: "module",
	plugins: ["typescript"],
});

const limitsByName = new Map<string, LazyStreamLimits>();
const registrations: Registration[] = [];

for (const stmt of ast.program.body) {
	let decl: t.Node = stmt;
	if (t.isExportNamedDeclaration(decl) && decl.declaration) {
		decl = decl.declaration;
	}
	if (t.isVariableDeclaration(decl)) {
		for (const declarator of decl.declarations) {
			if (!t.isIdentifier(declarator.id)) continue;
			const varName = declarator.id.name;

			// 1. Check for LazyStreamLimits declarations
			const typeAnnotation = declarator.id.typeAnnotation;
			const isLimitsDecl =
				t.isTSTypeAnnotation(typeAnnotation) &&
				t.isTSTypeReference(typeAnnotation.typeAnnotation) &&
				t.isIdentifier(typeAnnotation.typeAnnotation.typeName) &&
				typeAnnotation.typeAnnotation.typeName.name === "LazyStreamLimits";

			if (isLimitsDecl) {
				if (!t.isObjectExpression(declarator.init)) {
					throw new Error(`${varName}: expected ObjectExpression for LazyStreamLimits`);
				}
				const limits: LazyStreamLimits = {};
				for (const prop of declarator.init.properties) {
					if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) {
						throw new Error(`${varName}: unsupported property syntax in limits object`);
					}
					const key = prop.key.name;
					if (!(key in LIMITS_FIELD_KINDS)) {
						throw new Error(`${varName}: ${key} is not a LazyStreamLimits field`);
					}
					const expectedKind = LIMITS_FIELD_KINDS[key as keyof LazyStreamLimits];
					if (expectedKind === "number") {
						if (!t.isNumericLiteral(prop.value)) {
							throw new Error(`${varName}.${key}: expected number literal`);
						}
						limits[key as keyof LazyStreamLimits] = prop.value.value as never;
					} else if (expectedKind === "boolean") {
						if (!t.isBooleanLiteral(prop.value)) {
							throw new Error(`${varName}.${key}: expected boolean literal`);
						}
						limits[key as keyof LazyStreamLimits] = prop.value.value as never;
					}
				}
				limitsByName.set(varName, limits);
			}

			// 2. Check for createLazyStream registrations
			if (varName.startsWith("stream") && t.isCallExpression(declarator.init)) {
				const callExpr = declarator.init;
				if (t.isIdentifier(callExpr.callee) && callExpr.callee.name === "createLazyStream") {
					if (callExpr.arguments.length < 2 || callExpr.arguments.length > 3) {
						throw new Error(
							`${varName}: createLazyStream expects 2 or 3 arguments, got ${callExpr.arguments.length}`,
						);
					}

					// Arg 0: API key
					const arg0 = callExpr.arguments[0];
					if (!t.isStringLiteral(arg0)) {
						throw new Error(`${varName}: first argument must be a string literal API key`);
					}
					const api = arg0.value;

					// Arg 1: Dynamic import factory
					const arg1 = callExpr.arguments[1];
					if (!t.isArrowFunctionExpression(arg1) && !t.isFunctionExpression(arg1)) {
						throw new Error(`${varName}: second argument must be a dynamic import factory function`);
					}
					const moduleName = extractImportPathFromFactory(arg1);

					// Arg 2 (optional): Limits identifier
					let limitsName: string | undefined;
					let limits: LazyStreamLimits | undefined;
					if (callExpr.arguments.length === 3) {
						const arg2 = callExpr.arguments[2];
						if (!t.isIdentifier(arg2)) {
							throw new Error(`${varName}: third argument must be a limits identifier`);
						}
						limitsName = arg2.name;
						if (!limitsByName.has(limitsName)) {
							throw new Error(
								`${varName} passes ${limitsName}, which this lock could not parse from register-builtins.ts`,
							);
						}
						limits = limitsByName.get(limitsName);
					}

					registrations.push({ streamExport: varName, api, moduleName, limitsName, limits });
				}
			}
		}
	}
}

/** Provider names exported by the module at run time, the authority on membership. */
const exportedProviders = Object.entries(registerBuiltins)
	.filter(([name, value]) => name.startsWith("stream") && typeof value === "function")
	.map(([name]) => name)
	.sort();

/**
 * The other half of the membership question. `register-builtins.ts` is not the
 * only way a provider stream reaches a user: `stream.ts` dispatches some APIs
 * straight at their module (`gitlab-duo-agent`), and `transport: "pi-native"`
 * routes through the gateway client. Those paths never touch the shared
 * watchdog, so enumerating only the registrations would leave them unlocked.
 *
 * Membership here is the providers DIRECTORY, so a new provider module that
 * exports a stream entry point turns this file red until its row says what ends
 * its streams, and the row's token is checked against the code.
 */
interface UnregisteredStreamModule {
	reason: "own-watchdog" | "delegates" | "called-by-registered" | "no-transport";
	/** Token that must appear in this module's code (`delegates`, `own-watchdog`). */
	token?: string;
}

const UNREGISTERED_STREAM_MODULES: Record<string, UnregisteredStreamModule> = {
	// Bypasses register-builtins (see the `gitlab-duo-agent` branch in stream.ts)
	// and owns a 90s WebSocket idle timer, re-armed per inbound frame, plus
	// bounded stall/step-limit restarts.
	"gitlab-duo-workflow": { reason: "own-watchdog", token: "GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS" },
	// Gateway transport, dispatched from streamSimple; arms its own watchdog.
	"pi-native-client": { reason: "own-watchdog", token: "iterateWithIdleTimeout(" },
	// Thin routers over watched providers: their transport, and therefore their
	// watchdog, is the callee's.
	"gitlab-duo": { reason: "delegates", token: "streamOpenAICompletions" },
	"openai-anthropic-shim": { reason: "delegates", token: "streamOpenAICompletions" },
	kimi: { reason: "delegates", token: "streamOpenAIAnthropicShim" },
	synthetic: { reason: "delegates", token: "streamOpenAIAnthropicShim" },
	// A callee of the registered google/google-vertex modules, never reached on
	// its own, so the caller's budget governs it.
	"google-shared": { reason: "called-by-registered" },
	// In-memory fake with no transport: there is no wait to bound.
	mock: { reason: "no-transport" },
};

/**
 * Drives `work` under fake timers, advancing the clock a minute at a time and
 * draining microtasks between steps, until it settles. Exhausting the window is
 * the failure this file exists to catch: a watchdog that never fires does not
 * hang the suite, it reports the provider whose stream never ended.
 */
async function settleUnderAdvancingClock(work: Promise<void>, windowMs: number, label: string): Promise<void> {
	let settled = false;
	const tracked = work.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	const stepMs = 60_000;
	for (let elapsed = 0; elapsed <= windowMs && !settled; elapsed += stepMs) {
		for (let drain = 0; drain < 50 && !settled; drain++) await Promise.resolve();
		if (settled) break;
		vi.advanceTimersByTime(stepMs);
	}
	for (let drain = 0; drain < 50 && !settled; drain++) await Promise.resolve();
	if (!settled) throw new Error(`${label}: did not terminate within ${windowMs}ms of stream silence`);
	await tracked;
}

/** The error a terminating watchdog produces, or undefined if it produced none. */
async function drainForTimeout(
	stream: AsyncIterable<string>,
	budget: { idleTimeoutMs: number | undefined; firstItemTimeoutMs: number | undefined },
	windowMs: number,
	label: string,
): Promise<Error | undefined> {
	let caught: Error | undefined;
	const run = (async () => {
		try {
			for await (const _item of iterateWithIdleTimeout(stream, {
				idleTimeoutMs: budget.idleTimeoutMs,
				firstItemTimeoutMs: budget.firstItemTimeoutMs,
				errorMessage: "provider stream stalled",
				firstItemErrorMessage: "provider stream never started",
				// The #4593 stand-down, permanently engaged: the local bridge never
				// hands a result back, so the only way out is the cap.
				hasPendingLocalWork: () => true,
			})) {
				// Consume until the watchdog fires.
			}
		} catch (err) {
			caught = err instanceof Error ? err : new Error(String(err));
		}
	})();
	await settleUnderAdvancingClock(run, windowMs, label);
	return caught;
}

describe("lazy provider stream budget coverage", () => {
	it("every provider export has a recorded watchdog decision", () => {
		// Fail-by-default membership gate. A provider added without a row here is
		// red, whichever budget it happens to inherit.
		expect(Object.keys(WATCHDOG_DECISIONS).sort()).toEqual(exportedProviders);
		// And the source parse must see the same members, so a registration written
		// in a shape the parser misses cannot escape the assertions below.
		expect(registrations.map(entry => entry.streamExport).sort()).toEqual(exportedProviders);
		expect(exportedProviders.length).toBeGreaterThan(0);
	});

	it("each recorded decision matches the budget the code resolves", () => {
		// Resolved here rather than at module scope so the operator env knobs
		// `beforeEach` clears cannot leak into the baseline.
		const generic = registerBuiltins.resolveLazyStreamBudget({}, undefined);
		const mismatched: string[] = [];
		for (const registration of registrations) {
			const decision = WATCHDOG_DECISIONS[registration.streamExport];
			const budget = registerBuiltins.resolveLazyStreamBudget({}, registration.limits);
			const idle = budget.idleTimeoutMs;
			const first = budget.firstItemTimeoutMs;
			const detail = `${registration.streamExport} (${decision}): idle=${String(idle)} first=${String(first)}`;
			switch (decision) {
				case "provider-owned": {
					// The documented opt-out sentinel: no shared watchdog at all.
					if (registration.limits?.providerHandlesStreamTimeouts !== true) mismatched.push(detail);
					else if (idle !== undefined || first !== 0) mismatched.push(detail);
					break;
				}
				case "shared-generic-defaults": {
					if (idle !== generic.idleTimeoutMs || first !== generic.firstItemTimeoutMs) mismatched.push(detail);
					break;
				}
				case "shared-openai-env-precedence": {
					const sameNumbers = idle === generic.idleTimeoutMs && first === generic.firstItemTimeoutMs;
					if (!sameNumbers || registration.limits?.openAIIdleEnvFloorsFirstEvent !== true) {
						mismatched.push(detail);
					}
					break;
				}
				case "shared-widened-budget": {
					const bounded = typeof idle === "number" && idle > 0 && typeof first === "number" && first > 0;
					const widened =
						bounded &&
						((generic.idleTimeoutMs !== undefined && idle > generic.idleTimeoutMs) ||
							(generic.firstItemTimeoutMs !== undefined && first > generic.firstItemTimeoutMs));
					if (!widened) mismatched.push(detail);
					break;
				}
			}
		}
		// A row that does not describe what the code does is worse than no row: it
		// reads as a decision while the budget says something else.
		expect(mismatched).toEqual([]);
	});

	it("every provider module exporting a stream entry point is registered or has a recorded reason", async () => {
		const registeredModules = new Set(registrations.map(r => r.moduleName));
		const codeByModule = new Map<string, string>();
		const streamModules: string[] = [];
		for (const entry of await fs.readdir(PROVIDERS_DIR, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "register-builtins.ts") continue;
			const moduleName = entry.name.slice(0, -3);
			const text = await fs.readFile(path.join(PROVIDERS_DIR, entry.name), "utf8");
			const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
			// A stream ENTRY POINT, not any export whose name starts with "stream":
			// the declaration must take type parameters or arguments, which is what
			// separates `streamKimi(` from `streamOptionsSchema = type({`.
			const entries = [
				...code.matchAll(/^export (?:const|function) (stream[A-Z][A-Za-z0-9]*)(?::\s*StreamFunction<|[<(])/gm),
			];
			if (entries.length === 0) continue;
			codeByModule.set(moduleName, code);
			if (!registeredModules.has(moduleName)) streamModules.push(moduleName);
		}
		// Fail by default: a new stream-bearing module must be registered through
		// createLazyStream or carry a row saying what ends its streams.
		expect(streamModules.sort()).toEqual(Object.keys(UNREGISTERED_STREAM_MODULES).sort());

		const unproven: string[] = [];
		for (const moduleName of streamModules) {
			const row = UNREGISTERED_STREAM_MODULES[moduleName];
			const code = codeByModule.get(moduleName) ?? "";
			if (row.reason === "own-watchdog" || row.reason === "delegates") {
				if (row.token === undefined || !code.includes(row.token)) unproven.push(`${moduleName} (${row.reason})`);
				continue;
			}
			if (row.reason === "called-by-registered") {
				// Its stream entry point must actually be called from a registered
				// module, or "the caller's budget governs it" is not true.
				const names = [...code.matchAll(/^export (?:const|function) (stream[A-Z][A-Za-z0-9]*)/gm)].map(m => m[1]);
				let called = false;
				for (const registered of registeredModules) {
					const callerCode = await fs.readFile(path.join(PROVIDERS_DIR, `${registered}.ts`), "utf8");
					if (names.some(name => callerCode.includes(`${name}(`))) {
						called = true;
						break;
					}
				}
				if (!called) unproven.push(`${moduleName} (called-by-registered)`);
			}
		}
		expect(unproven).toEqual([]);
	});

	it("every provider taking the opt-out arms its own idle watchdog", async () => {
		const optedOut = registrations.filter(
			registration => registration.limits?.providerHandlesStreamTimeouts === true,
		);
		// The opt-out exists for OpenAI-family and Anthropic transports; if it stops
		// being used at all this test would pass vacuously.
		expect(optedOut.length).toBeGreaterThan(0);
		const unarmed: string[] = [];
		for (const registration of optedOut) {
			const moduleName = registration.moduleName;
			const text = await fs.readFile(path.join(PROVIDERS_DIR, `${moduleName}.ts`), "utf8");
			// Comments stripped: a module that only MENTIONS the watchdog in prose has
			// not armed one.
			const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
			const imports = code.includes("iterateWithIdleTimeout,") || code.includes("iterateWithIdleTimeout }");
			if (!imports || !code.includes("iterateWithIdleTimeout(")) {
				unarmed.push(`${registration.streamExport} (${moduleName}.ts)`);
			}
		}
		expect(unarmed).toEqual([]);
	});

	it("the source-parsed limits match the real exported object", () => {
		// Proves the parser above reads what the module actually holds, so the
		// budgets asserted are the budgets providers run under.
		expect(limitsByName.get("AGENTIC_BACKEND_LAZY_STREAM_LIMITS")).toEqual(
			registerBuiltins.AGENTIC_BACKEND_LAZY_STREAM_LIMITS,
		);
	});

	// Termination, not values. Every provider on the shared watchdog is driven
	// with the stand-down permanently engaged, in both phases, and must end. The
	// window is the 90-minute local-work cap plus the widest provider budget plus
	// slack, so a provider that widens its budget stays covered.
	const sharedWatchdogProviders = registrations.filter(
		registration => registration.limits?.providerHandlesStreamTimeouts !== true,
	);
	const TERMINATION_WINDOW_MS = 90 * 60_000 + 30 * 60_000;

	for (const registration of sharedWatchdogProviders) {
		it(`${registration.streamExport}: a wedged local tool cannot hold the stream open forever`, async () => {
			vi.useFakeTimers();
			const budget = registerBuiltins.resolveLazyStreamBudget({}, registration.limits);
			const wedged = Promise.withResolvers<never>();
			async function* midStream(): AsyncGenerator<string> {
				yield "first";
				await wedged.promise;
			}
			const error = await drainForTimeout(midStream(), budget, TERMINATION_WINDOW_MS, registration.streamExport);
			// Named cause: a wedged bridge must be diagnosable, not indistinguishable
			// from a provider that went quiet.
			expect(error?.message).toBe("provider stream stalled (a local tool held the stream open without completing)");
		});

		it(`${registration.streamExport}: a wedged local tool cannot hold the first event open forever`, async () => {
			vi.useFakeTimers();
			const budget = registerBuiltins.resolveLazyStreamBudget({}, registration.limits);
			const wedged = Promise.withResolvers<never>();
			// Nothing ever arrives, so the first-item phase owns the whole wait. This
			// is the variant the mid-stream test cannot see: a bridge that wedges
			// before the provider has emitted anything at all.
			const neverStarts: AsyncIterable<string> = {
				[Symbol.asyncIterator]: () => ({ next: () => wedged.promise }),
			};
			const error = await drainForTimeout(neverStarts, budget, TERMINATION_WINDOW_MS, registration.streamExport);
			expect(error?.message).toBe(
				"provider stream never started (a local tool held the stream open without completing)",
			);
		});
	}
});
