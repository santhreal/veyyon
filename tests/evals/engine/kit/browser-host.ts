/**
 * What a kit suite whose trials use the browser tool needs from the host: the tool turned on, and
 * the Chromium it launches.
 *
 * The browser tool finds Chromium in a cache under the user's home, which a sandboxed trial cannot
 * read. The runner resolves the executable once, outside the sandbox, and each trial gets it by
 * `PUPPETEER_EXECUTABLE_PATH` with its directory granted readable.
 */

import * as path from "node:path";
import { ensureChromiumExecutable } from "@veyyon/coding-agent/tools/web/browser/launch";
import { errorMessage } from "@veyyon/utils";
import type { PreflightVerdict } from "../contracts";
import type { HostEnvironment } from "./suite";

/** The browser tool on, headless, driving Chromium through puppeteer. */
export const BROWSER_TOOL_SETTINGS: Readonly<Record<string, unknown>> = {
	browser: { enabled: true, headless: true, cmux: false },
};

async function chromiumExecutable(): Promise<string> {
	const executable = await ensureChromiumExecutable();
	if (!executable) throw new Error("no Chromium executable for this platform; set PUPPETEER_EXECUTABLE_PATH");
	return executable;
}

export async function browserHostEnvironment(): Promise<HostEnvironment> {
	const executable = await chromiumExecutable();
	return { env: { PUPPETEER_EXECUTABLE_PATH: executable }, readable: [path.dirname(executable)] };
}

/** Refuses a run on a host where no Chromium can be found or installed. */
export async function chromiumPreflight(): Promise<PreflightVerdict> {
	try {
		await chromiumExecutable();
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: errorMessage(error), missingRequirements: ["chromium"] };
	}
}
