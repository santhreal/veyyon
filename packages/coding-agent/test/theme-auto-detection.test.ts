import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@veyyon/coding-agent/modes/theme/theme";
import * as nativesModule from "@veyyon/natives";
import { MacOSAppearance } from "@veyyon/natives";

const originalPlatform = process.platform;
const originalColorfgbg = Bun.env.COLORFGBG;
const originalZellij = Bun.env.ZELLIJ;

type ThemeTestGlobals = {
	platform?: NodeJS.Platform;
	colorfgbg?: string;
	zellij?: string;
};

const withThemeTestGlobals = (globals: ThemeTestGlobals = {}) => {
	Object.defineProperty(process, "platform", {
		value: globals.platform ?? "darwin",
		configurable: true,
		writable: true,
	});

	if (globals.colorfgbg === undefined) delete Bun.env.COLORFGBG;
	else Bun.env.COLORFGBG = globals.colorfgbg;

	if (globals.zellij === undefined) delete Bun.env.ZELLIJ;
	else Bun.env.ZELLIJ = globals.zellij;

	return {
		[Symbol.dispose]() {
			themeModule.stopThemeWatcher();
			Object.defineProperty(process, "platform", {
				value: originalPlatform,
				configurable: true,
				writable: true,
			});
			if (originalColorfgbg === undefined) delete Bun.env.COLORFGBG;
			else Bun.env.COLORFGBG = originalColorfgbg;
			if (originalZellij === undefined) delete Bun.env.ZELLIJ;
			else Bun.env.ZELLIJ = originalZellij;
			vi.restoreAllMocks();
		},
	};
};

describe("theme auto-detection", () => {
	beforeEach(async () => {
		themeModule.stopThemeWatcher();
		const darkTheme = await themeModule.getThemeByName("dark");
		if (!darkTheme) {
			throw new Error("Failed to load dark theme for tests");
		}
		themeModule.setThemeInstance(darkTheme);
		vi.restoreAllMocks();
	});

	afterEach(() => {
		themeModule.stopThemeWatcher();
		vi.restoreAllMocks();
	});

	it("prefers COLORFGBG before macOS fallback inside Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1", colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	// The observer is faked through the theme module's own seam
	// (`setMacAppearanceObserverStarterForTest`), never `vi.spyOn` on the
	// native class: that export is a lazy Proxy, so spying installs the mock
	// on the proxy's dummy target while `get` keeps returning the real
	// binding (the spy records 0 calls), and merely ACCESSING `.start` loads
	// the darwin addon — which does not exist on non-mac dev hosts.
	it("keeps honoring terminal-reported appearance outside fallback mode", async () => {
		using _globals = withThemeTestGlobals();
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		const starter = vi.fn(() => ({ stop: vi.fn() }));
		themeModule.setMacAppearanceObserverStarterForTest(starter);
		try {
			themeModule.onTerminalAppearanceChange("dark");
			await themeModule.initTheme(true, undefined, undefined, "dark", "light");

			expect(themeModule.getCurrentThemeName()).toBe("dark");
			expect(detectSpy).not.toHaveBeenCalled();
			expect(starter).not.toHaveBeenCalled();
		} finally {
			themeModule.setMacAppearanceObserverStarterForTest(undefined);
		}
	});

	it("updates auto theme from the native fallback observer in Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1" });
		const stop = vi.fn();
		let onAppearanceChange: ((appearance: "dark" | "light") => void) | undefined;
		vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		const starter = vi.fn((callback: (err: Error | null, appearance: string) => void) => {
			onAppearanceChange = (appearance: "dark" | "light") => callback(null, appearance);
			return { stop };
		});
		themeModule.setMacAppearanceObserverStarterForTest(starter);
		try {
			await themeModule.initTheme(true, undefined, undefined, "dark", "light");

			expect(starter).toHaveBeenCalledTimes(1);
			expect(themeModule.getCurrentThemeName()).toBe("light");
			expect(onAppearanceChange).toBeDefined();

			onAppearanceChange!("dark");
			await Bun.sleep(0);

			expect(themeModule.getCurrentThemeName()).toBe("dark");
			themeModule.stopThemeWatcher();
			expect(stop).toHaveBeenCalledTimes(1);
		} finally {
			themeModule.setMacAppearanceObserverStarterForTest(undefined);
		}
	});
	it("Zellij fallback stays macOS-only (Linux + Zellij = honor terminal)", async () => {
		using _globals = withThemeTestGlobals({ platform: "linux", zellij: "1" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("terminal-reported appearance wins over conflicting COLORFGBG", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("light");
		expect(detectSpy).not.toHaveBeenCalled();
	});
});
