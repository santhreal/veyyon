import { basename } from "node:path";

const EXCLUDED_FILES = [
	"Cargo.lock",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"shrinkwrap.yaml",
	"bun.lock",
	"bun.lockb",
	"deno.lock",
	"composer.lock",
	"Gemfile.lock",
	"poetry.lock",
	"Pipfile.lock",
	"pdm.lock",
	"uv.lock",
	"go.sum",
	"flake.lock",
	"pubspec.lock",
	"Podfile.lock",
	"Packages.resolved",
	"mix.lock",
	"packages.lock.json",
	"gradle.lockfile",
	"config.yml.lock",
	"config.yaml.lock",
	"settings.yml.lock",
	"settings.yaml.lock",
];

const EXCLUDED_SUFFIXES = [".lock.yml", ".lock.yaml", "-lock.yml", "-lock.yaml"];

/** Lowercased basenames for O(1) exact-match exclusion. */
const EXCLUDED_NAMES = new Set(EXCLUDED_FILES.map(name => name.toLowerCase()));

export function isExcludedFile(path: string): boolean {
	// Match the file's basename, not the whole path. A full-path `endsWith`
	// wrongly excludes real source files that merely end with an excluded name
	// (e.g. `service-go.sum` ends with `go.sum`, `app-package-lock.json` ends
	// with `package-lock.json`). Excluded suffixes stay a basename suffix test so
	// `config/app.lock.yml` is still caught.
	const name = basename(path).toLowerCase();
	if (EXCLUDED_NAMES.has(name)) {
		return true;
	}
	return EXCLUDED_SUFFIXES.some(suffix => name.endsWith(suffix));
}

export function filterExcludedFiles<T extends { filename: string }>(files: T[]): T[] {
	return files.filter(file => !isExcludedFile(file.filename));
}
