import type { BundledCommandAPI } from "../../../../extensibility/custom-commands/types";
import * as git from "../../../../utils/git";

/** The tag at HEAD, if there is one. Undefined is the ordinary answer: most commits carry no tag, so the listing comes back empty and `[0]` is already undefined without any failure. The catch adds the */
export async function getHeadTag(api: BundledCommandAPI): Promise<string | undefined> {
	try {
		return (await git.ref.tags(api.cwd))[0];
	} catch {
		return undefined;
	}
}

/** The remote this branch pushes to, or undefined when it has none configured. `git config --get` EXITS NON-ZERO for a key that is not set, so the throw is how "not configured" */
export async function getPushRemote(api: BundledCommandAPI, branch: string): Promise<string | undefined> {
	try {
		return (
			(await git.config.getBranch(api.cwd, branch, "pushRemote")) ??
			(await git.config.getBranch(api.cwd, branch, "remote"))
		);
	} catch {
		return undefined;
	}
}

export async function getHeadTagContext(
	api: BundledCommandAPI,
): Promise<{ branch: string; headTag?: string; remote: string }> {
	const branch = await git.branch.currentOrHead(api.cwd);
	const [headTag, pushRemote] = await Promise.all([getHeadTag(api), getPushRemote(api, branch)]);
	return {
		headTag,
		branch,
		remote: pushRemote ?? "origin",
	};
}
