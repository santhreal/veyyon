import { type GitSource, parseGitUrl } from "./git-url";
import { extractPackageName } from "./parser";

export const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._^~>=<]+)?$/i;

export const SHELL_METACHARS = /[;&|`$(){}<>\\\n\r\t]/;

export function validatePackageName(name: string): void {
	const baseName = extractPackageName(name);
	if (!VALID_PACKAGE_NAME.test(baseName)) {
		throw new Error(
			`"${name}" is not a valid npm package name, so nothing was installed. ` +
				"Fix: an npm plugin is `name`, `@scope/name`, or either with `@version`. " +
				"For a git plugin use the git form instead, e.g. `veyyon plugin install github:user/repo`.",
		);
	}
	if (/[;&|`$(){}[\]<>\\]/.test(name)) {
		throw new Error(
			`"${name}" contains characters that are never part of a package name, so nothing was installed. ` +
				"Fix: pass just the package name, with no shell punctuation.",
		);
	}
}

export function validateGitSpec(spec: string): void {
	if (SHELL_METACHARS.test(spec)) {
		throw new Error(
			`"${spec}" contains shell punctuation, so nothing was installed. ` +
				"Fix: pass the plain source, e.g. `github:user/repo` or `https://github.com/user/repo`.",
		);
	}
}

export function pluginNotInRuntimeConfigMessage(name: string): string {
	return (
		`No plugin named "${name}" is installed, so nothing was changed. ` +
		`Fix: run \`veyyon plugin list\` to see the installed names, or \`veyyon plugin install ${name}\` to add it.`
	);
}

export function gitInstallSpec(original: string, source: GitSource): string {
	if (/^github:/i.test(original) || !/^[a-z]+:[^/]/i.test(original)) {
		return original;
	}
	if (!source.ref || source.repo.includes("#")) {
		return source.repo;
	}
	return `${source.repo}#${source.ref}`;
}

export function findGitPackageName(source: GitSource, deps: Record<string, string>): string | undefined {
	for (const [key, value] of Object.entries(deps)) {
		if (typeof value !== "string") {
			continue;
		}
		const installedSource = parseGitUrl(value);
		if (installedSource && installedSource.host === source.host && installedSource.path === source.path) {
			return key;
		}
	}
	return undefined;
}

export function parseDryRunResolution(stdout: string): { name: string; version: string } | null {
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (!line.startsWith("installed ")) {
			continue;
		}
		const descriptor = line
			.slice("installed ".length)
			.replace(/ with binaries:$/, "")
			.trim();
		const separator = descriptor.indexOf("@", 1);
		if (separator === -1) {
			continue;
		}
		const name = descriptor.slice(0, separator);
		const version = descriptor.slice(separator + 1);
		if (name && version) {
			return { name, version };
		}
	}
	return null;
}

export function hasDefaultExport(value: unknown): value is { default?: unknown } {
	return typeof value === "object" && value !== null && "default" in value;
}

export function hasExtensionFactoryExport(module: unknown): boolean {
	return typeof module === "function" || (hasDefaultExport(module) && typeof module.default === "function");
}

export interface PluginPackageSnapshot {
	readonly actualName: string;
	readonly packagePath: string;
	readonly backupRoot: string;
	readonly backupPath: string;
}

export interface RuntimePackageJson {
	name?: unknown;
}
