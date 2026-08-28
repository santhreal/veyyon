import { __veyyonNativesV1_2_0 } from "@veyyon/natives";
import { scenarioEnv } from "./scenarios";
import type { EnvKey, Scenario } from "./types";
import { ENV_KEYS } from "./types";

export interface StressEnvSnapshot {
	bun: Record<EnvKey, string | undefined>;
	process: Record<EnvKey, string | undefined>;
}

export function applyStressEnv(envMode: Scenario["envMode"]): StressEnvSnapshot {
	const envPatch = scenarioEnv(envMode);
	const snapshot: StressEnvSnapshot = {
		bun: {
			TMUX: undefined,
			STY: undefined,
			ZELLIJ: undefined,
			TERMUX_VERSION: undefined,
			WEZTERM_PANE: undefined,
			KITTY_WINDOW_ID: undefined,
			GHOSTTY_RESOURCES_DIR: undefined,
			ALACRITTY_WINDOW_ID: undefined,
			VTE_VERSION: undefined,
			VEYYON_NO_SYNC_OUTPUT: undefined,
			TERM_PROGRAM: undefined,
			ITERM_SESSION_ID: undefined,
			WT_SESSION: undefined,
			WSL_DISTRO_NAME: undefined,
			WSL_INTEROP: undefined,
		},
		process: {
			TMUX: undefined,
			STY: undefined,
			ZELLIJ: undefined,
			TERMUX_VERSION: undefined,
			WEZTERM_PANE: undefined,
			KITTY_WINDOW_ID: undefined,
			GHOSTTY_RESOURCES_DIR: undefined,
			ALACRITTY_WINDOW_ID: undefined,
			VTE_VERSION: undefined,
			VEYYON_NO_SYNC_OUTPUT: undefined,
			TERM_PROGRAM: undefined,
			ITERM_SESSION_ID: undefined,
			WT_SESSION: undefined,
			WSL_DISTRO_NAME: undefined,
			WSL_INTEROP: undefined,
		},
	};
	for (const key of ENV_KEYS) {
		snapshot.bun[key] = Bun.env[key];
		snapshot.process[key] = process.env[key];
		const value = envPatch[key];
		if (value === undefined) {
			delete Bun.env[key];
			delete process.env[key];
		} else {
			Bun.env[key] = value;
			process.env[key] = value;
		}
	}
	return snapshot;
}

export function restoreStressEnv(snapshot: StressEnvSnapshot): void {
	for (const key of ENV_KEYS) {
		const bunValue = snapshot.bun[key];
		if (bunValue === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = bunValue;
		}
		const processValue = snapshot.process[key];
		if (processValue === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = processValue;
		}
	}
}

export let stressEnvPatchDepth = 0;
export let platformPatchDepth = 0;

export async function withPatchedEnv<T>(envMode: Scenario["envMode"], run: () => Promise<T>): Promise<T> {
	if (stressEnvPatchDepth > 0) throw new Error("Nested stress environment patching is not supported");
	stressEnvPatchDepth += 1;
	const snapshot = applyStressEnv(envMode);
	try {
		return await run();
	} finally {
		restoreStressEnv(snapshot);
		stressEnvPatchDepth -= 1;
	}
}

export async function withPatchedPlatform<T>(platform: Scenario["platform"], run: () => Promise<T>): Promise<T> {
	if (platformPatchDepth > 0) throw new Error("Nested stress platform patching is not supported");
	// Force the native addon to load for the REAL host platform before the
	// patch: the loader memoizes on first call, so darwin/win32 scenarios
	// reuse the host addon instead of demanding a `.node` that cannot exist
	// here. The patch tests JS render logic; the native width functions are
	// platform-independent, so the host binding is correct either way.
	__veyyonNativesV1_2_0();
	platformPatchDepth += 1;
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	try {
		return await run();
	} finally {
		if (platformDescriptor !== undefined) {
			Object.defineProperty(process, "platform", platformDescriptor);
		} else {
			Reflect.deleteProperty(process, "platform");
		}
		platformPatchDepth -= 1;
	}
}
