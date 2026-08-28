import type { SplitCommitPlan } from "./state";

export const LOCK_FILE_MANIFESTS: Readonly<Record<string, readonly string[]>> = {
	"Cargo.lock": ["Cargo.toml"],
	"package-lock.json": ["package.json"],
	"yarn.lock": ["package.json"],
	"pnpm-lock.yaml": ["package.json"],
	"bun.lock": ["package.json"],
	"bun.lockb": ["package.json"],
	"go.sum": ["go.mod"],
	"poetry.lock": ["pyproject.toml"],
	"Pipfile.lock": ["Pipfile"],
	"uv.lock": ["pyproject.toml"],
	"composer.lock": ["composer.json"],
	"Gemfile.lock": ["Gemfile"],
	"flake.lock": ["flake.nix"],
	"pubspec.lock": ["pubspec.yaml"],
	"Podfile.lock": ["Podfile"],
	"mix.lock": ["mix.exs"],
	"gradle.lockfile": ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
};

export const EXCLUDED_LOCK_FILES: ReadonlySet<string> = new Set(Object.keys(LOCK_FILE_MANIFESTS));

export function assignLockFilesToPlan(plan: SplitCommitPlan, stagedFiles: readonly string[]): void {
	if (plan.commits.length === 0) return;

	const planned = new Set(plan.commits.flatMap(commit => commit.changes.map(change => change.path)));
	const orphanedLockFiles: string[] = [];
	for (const file of stagedFiles) {
		if (planned.has(file)) continue;
		const parts = file.split("/");
		const basename = parts[parts.length - 1];
		if (EXCLUDED_LOCK_FILES.has(basename)) orphanedLockFiles.push(file);
	}
	if (orphanedLockFiles.length === 0) return;

	for (const lockFile of orphanedLockFiles) {
		const parts = lockFile.split("/");
		const basename = parts[parts.length - 1];
		const dir = parts.slice(0, -1).join("/");
		const manifests = LOCK_FILE_MANIFESTS[basename] ?? [];
		const targetIndex = findManifestCommitIndex(plan, dir, manifests);
		plan.commits[targetIndex].changes.push({ path: lockFile, hunks: { type: "all" } });
		planned.add(lockFile);
	}
}

function findManifestCommitIndex(plan: SplitCommitPlan, lockDir: string, manifests: readonly string[]): number {
	for (const manifestName of manifests) {
		for (let i = 0; i < plan.commits.length; i++) {
			for (const change of plan.commits[i].changes) {
				const parts = change.path.split("/");
				const basename = parts[parts.length - 1];
				const dir = parts.slice(0, -1).join("/");
				if (basename === manifestName && dir === lockDir) return i;
			}
		}
	}
	for (const manifestName of manifests) {
		for (let i = 0; i < plan.commits.length; i++) {
			for (const change of plan.commits[i].changes) {
				const parts = change.path.split("/");
				if (parts[parts.length - 1] === manifestName) return i;
			}
		}
	}
	return plan.commits.length - 1;
}
