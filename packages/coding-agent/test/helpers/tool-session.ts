/**
 * The one place tests build a `ToolSession`.
 *
 * `ToolSession` requires exactly three members (`cwd`, `hasUI`,
 * `getSessionFile`); everything else on it is optional. Despite that, 46 test
 * files hand-rolled their own stub and forced it through with
 * `as unknown as ToolSession`. That double cast is not just unnecessary, it is
 * actively harmful in two ways:
 *
 * 1. It switches off checking of the optional members the stub DOES set. A
 *    misspelled `hasEditTool` or a `getSessionId` returning the wrong type is
 *    accepted silently as an excess property, so the stub configures nothing
 *    and the test passes for the wrong reason.
 * 2. It makes the stub structurally unrelated to the interface, so the stub can
 *    never fail to keep up with it. That is exactly how the print-mode suite
 *    rotted: a method was added to the consumer, the cast hid that the stub
 *    lacked it, and four tests died at runtime instead of at build time.
 *
 * Use this helper instead. It is typed, so an unknown key or a wrong signature
 * is a build error at the call site, and a new required member on `ToolSession`
 * is a single failure here rather than 46 silent stubs that no longer match.
 */
import type { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools/index";

/**
 * A stand-in for `Settings`, which a test cannot construct.
 *
 * `Settings` has a private constructor and is created only through the module's
 * own loader, so there is no way to build a real one for a unit test. This is
 * the single place that gap is bridged, and it is the only assertion left in
 * this helper. Containing it here is the point: it used to be repeated inside
 * all 52 `as unknown as ToolSession` casts, where it also switched off checking
 * of every other member those stubs set.
 */
export type SettingsStub = { get(path: string): unknown } & Partial<Omit<Settings, "get">>;

/** Overrides accepted by {@link makeToolSession}. Fully checked except `settings`. */
export type ToolSessionOverrides = Omit<Partial<ToolSession>, "settings"> & { settings?: SettingsStub };

/**
 * Build a `ToolSession` for a test, overriding only what the test cares about.
 *
 * The defaults are the inert ones: the current directory, no UI, no session
 * file, no spawns, and settings that answer `undefined` for everything (so each
 * setting falls to its own default). A test that depends on any of these states
 * it explicitly.
 */
export function makeToolSession(overrides: ToolSessionOverrides = {}): ToolSession {
	const { settings, ...rest } = overrides;
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: (settings ?? { get: () => undefined }) as Settings,
		...rest,
	};
}
