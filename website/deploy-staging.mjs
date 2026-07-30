import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Copy a Pages source tree into a temporary directory while resolving symlinks.
 * Wrangler hashes the symlink inode instead of its target on some releases, so
 * deploying `website/docs` directly can reuse stale handbook assets.
 */
export function stageDeployTree(sourceDirectory) {
	const temporaryRoot = fs.mkdtempSync(path.join(path.dirname(sourceDirectory), ".veyyon-pages-deploy-"));
	const directory = path.join(temporaryRoot, path.basename(sourceDirectory));
	try {
		fs.cpSync(sourceDirectory, directory, { recursive: true, dereference: true });
	} catch (error) {
		fs.rmSync(temporaryRoot, { recursive: true, force: true });
		throw error;
	}
	return {
		directory,
		cleanup() {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		},
	};
}

/**
 * Find a real Node executable when `bun run` has placed its `node` shim first.
 * Cloudflare Wrangler does not support Bun, so deployment must bypass that shim.
 */
export function findExternalNodeExecutable({
	pathValue = process.env.PATH ?? "",
	currentExecutable = process.execPath,
	explicit = process.env.VEYYON_NODE_BINARY,
} = {}) {
	const executableName = process.platform === "win32" ? "node.exe" : "node";
	const candidates = explicit
		? [explicit]
		: pathValue.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, executableName));
	let currentRealPath = currentExecutable;
	try {
		currentRealPath = fs.realpathSync(currentExecutable);
	} catch {}
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			if (fs.realpathSync(candidate) !== currentRealPath) return candidate;
		} catch {}
	}
	throw new Error(
		"Cloudflare Pages deployment requires Node outside Bun; install Node 22 or set VEYYON_NODE_BINARY",
	);
}

/**
 * Refuse to report success unless Cloudflare exposes a new production deployment.
 * Wrangler has returned zero after a failed project fetch, so its exit code alone
 * is not evidence that any files reached Pages.
 */
export function assertNewDeployment(previousId, currentId, project) {
	if (!currentId) {
		throw new Error(`Cloudflare Pages returned no production deployment for '${project}' after upload`);
	}
	if (currentId === previousId) {
		throw new Error(
			`Cloudflare Pages did not create a new production deployment for '${project}'; Wrangler exited without uploading`,
		);
	}
	return currentId;
}
