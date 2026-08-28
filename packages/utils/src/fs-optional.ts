import type { Dirent, Stats } from "node:fs";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { reportFault } from "./fault-sink";
import { isEnoent } from "./fs-error";

export async function readdirIfPresent(dir: string, what: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		reportFault({
			source: "filesystem",
			text: `${dir} exists but could not be listed, so ${what} could not be loaded and this run is continuing without any. Check the directory's permissions and whether its filesystem is mounted.`,
			context: { dir, what, error: String(error) },
		});
		return [];
	}
}

export async function pathExists(target: string, what: string): Promise<boolean> {
	return (await statIfPresent(target, what)) !== undefined;
}

export async function statIfPresent(target: string, what: string): Promise<Stats | undefined> {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		reportFault({
			source: "filesystem",
			text: `${target} could not be read while probing for ${what}, so it is being treated as absent and anything that depends on it is switched off. Check the path's permissions and whether its filesystem is mounted.`,
			context: { path: target, what, error: String(error) },
		});
		return undefined;
	}
}

export async function statIfPresentOrThrow(target: string): Promise<Stats | undefined> {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

export async function pathExistsOrThrow(target: string): Promise<boolean> {
	return (await statIfPresentOrThrow(target)) !== undefined;
}

export async function pathExistsQuietly(target: string, why: string): Promise<boolean> {
	void why;
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

export type PathState = "present" | "absent" | "unreadable";

export async function pathState(target: string): Promise<PathState> {
	let stat: Stats;
	try {
		stat = await fs.stat(target);
	} catch (error) {
		return isEnoent(error) ? "absent" : "unreadable";
	}
	if (!stat.isDirectory()) return "present";
	try {
		await fs.access(target, fsConstants.R_OK | fsConstants.X_OK);
		return "present";
	} catch {
		return "unreadable";
	}
}

export function pathStateSync(target: string): PathState {
	let stat: Stats;
	try {
		stat = statSync(target);
	} catch (error) {
		return isEnoent(error) ? "absent" : "unreadable";
	}
	if (!stat.isDirectory()) return "present";
	try {
		accessSync(target, fsConstants.R_OK | fsConstants.X_OK);
		return "present";
	} catch {
		return "unreadable";
	}
}
