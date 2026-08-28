import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, getAgentDir } from "@veyyon/utils";

export interface CustomShareResult {
	url?: string;
	message?: string;
}

export type CustomShareFn = (htmlPath: string) => Promise<CustomShareResult | string | undefined>;

export interface LoadedCustomShare {
	path: string;
	fn: CustomShareFn;
}

const SHARE_SCRIPT_CANDIDATES = ["share.ts", "share.js", "share.mjs"];

export function getCustomSharePath(): string | null {
	const agentDir = getAgentDir();

	for (const candidate of SHARE_SCRIPT_CANDIDATES) {
		const scriptPath = path.join(agentDir, candidate);
		if (fs.existsSync(scriptPath)) {
			return scriptPath;
		}
	}

	return null;
}

export async function loadCustomShare(): Promise<LoadedCustomShare | null> {
	const scriptPath = getCustomSharePath();
	if (!scriptPath) {
		return null;
	}

	try {
		const module = await import(scriptPath);
		const fn = module.default;

		if (typeof fn !== "function") {
			throw new Error("share script must export a default function");
		}

		return { path: scriptPath, fn };
	} catch (err) {
		const message = errorMessage(err);
		throw new Error(`Failed to load share script: ${message}`);
	}
}
