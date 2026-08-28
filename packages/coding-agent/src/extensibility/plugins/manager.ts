import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	errorMessage,
	getPluginsDir,
	getPluginsLockfile,
	getPluginsNodeModules,
	getPluginsPackageJson,
	getProjectDir,
	getProjectPluginOverridesPath,
	isEnoent,
	logger,
	pathExists,
	pathState,
	readPipeText,
} from "@veyyon/utils";
import { adoptIntoPrimarySessionCpuBudget } from "../../session/cpu-limit";
import { type ManifestHolder, manifestFromPackageJson } from "../manifest-key";
import { withExitGuard } from "../utils";
import { refreshBunGitCache } from "./bun-git-cache";
import { type GitSource, parseGitUrl } from "./git-url";
import { getInstalledPluginsRegistryPath, readInstalledPluginsRegistry } from "./installed-registry";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "./legacy-pi-compat";
import { resolvePluginManifestEntries } from "./loader";
import { extractPackageName, type ParsedPluginSpec, parsePluginSpec } from "./parser";
import { parsePluginId } from "./plugin-id";
import { normalizePluginRuntimeConfig } from "./runtime-config";
import type {
	DoctorCheck,
	DoctorOptions,
	InstalledPlugin,
	InstallOptions,
	PluginManifest,
	PluginRuntimeConfig,
	PluginSettingSchema,
	ProjectPluginOverrides,
} from "./types";

const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._^~>=<]+)?$/i;

const SHELL_METACHARS = /[;&|`$(){}<>\\\n\r\t]/;

function validatePackageName(name: string): void {
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

function validateGitSpec(spec: string): void {
	if (SHELL_METACHARS.test(spec)) {
		throw new Error(
			`"${spec}" contains shell punctuation, so nothing was installed. ` +
				"Fix: pass the plain source, e.g. `github:user/repo` or `https://github.com/user/repo`.",
		);
	}
}

function pluginNotInRuntimeConfigMessage(name: string): string {
	return (
		`No plugin named "${name}" is installed, so nothing was changed. ` +
		`Fix: run \`veyyon plugin list\` to see the installed names, or \`veyyon plugin install ${name}\` to add it.`
	);
}

function gitInstallSpec(original: string, source: GitSource): string {
	if (/^github:/i.test(original) || !/^[a-z]+:[^/]/i.test(original)) {
		return original;
	}
	if (!source.ref || source.repo.includes("#")) {
		return source.repo;
	}
	return `${source.repo}#${source.ref}`;
}

function findGitPackageName(source: GitSource, deps: Record<string, string>): string | undefined {
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

function parseDryRunResolution(stdout: string): { name: string; version: string } | null {
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

function hasDefaultExport(value: unknown): value is { default?: unknown } {
	return typeof value === "object" && value !== null && "default" in value;
}

function hasExtensionFactoryExport(module: unknown): boolean {
	return typeof module === "function" || (hasDefaultExport(module) && typeof module.default === "function");
}

interface PluginPackageSnapshot {
	readonly actualName: string;
	readonly packagePath: string;
	readonly backupRoot: string;
	readonly backupPath: string;
}

interface RuntimePackageJson {
	name?: unknown;
}
export class PluginManager {
	#runtimeConfig: PluginRuntimeConfig | null = null;
	#cwd: string;

	constructor(cwd: string = getProjectDir()) {
		this.#cwd = cwd;
	}

	async #loadRuntimeConfig(): Promise<PluginRuntimeConfig> {
		const lockPath = getPluginsLockfile();
		try {
			return normalizePluginRuntimeConfig(await Bun.file(lockPath).json());
		} catch (err) {
			if (isEnoent(err)) return normalizePluginRuntimeConfig({});
			logger.warn(
				`The plugin runtime config at ${lockPath} could not be read, so every plugin is treated as ` +
					`enabled with default settings for this run: ${errorMessage(err)}. ` +
					"Fix: check that file's permissions, or delete it and re-apply your choices with " +
					"`veyyon plugin enable <name>` and `veyyon plugin disable <name>`.",
				{ path: lockPath, error: errorMessage(err) },
			);
			return normalizePluginRuntimeConfig({});
		}
	}

	async #ensureConfigLoaded(): Promise<PluginRuntimeConfig> {
		if (!this.#runtimeConfig) {
			this.#runtimeConfig = await this.#loadRuntimeConfig();
		}
		return this.#runtimeConfig;
	}

	async #saveRuntimeConfig(): Promise<void> {
		await this.#ensureConfigLoaded();
		await Bun.write(getPluginsLockfile(), JSON.stringify(this.#runtimeConfig, null, 2));
	}

	async #loadProjectOverrides(): Promise<ProjectPluginOverrides> {
		const overridesPath = getProjectPluginOverridesPath(this.#cwd);
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) return {};
			logger.warn(
				`The project plugin overrides at ${overridesPath} could not be read, so this project's plugin ` +
					`choices are ignored and the user-level ones apply instead: ${errorMessage(err)}. ` +
					"Fix: check that file's permissions, or delete it to drop the project overrides deliberately.",
				{ path: overridesPath, error: errorMessage(err) },
			);
			return {};
		}
	}

	async #ensurePluginsDir(): Promise<void> {
		await fs.promises.mkdir(getPluginsDir(), { recursive: true });
		await fs.promises.mkdir(getPluginsNodeModules(), { recursive: true });
	}

	async #ensurePackageJson(): Promise<void> {
		const pkgJsonPath = getPluginsPackageJson();
		try {
			await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				await Bun.write(
					pkgJsonPath,
					JSON.stringify(
						{
							name: "veyyon-plugins",
							private: true,
							dependencies: {},
						},
						null,
						2,
					),
				);
				return;
			}
			throw err;
		}
	}

	async #readDeps(pkgJsonPath: string): Promise<Record<string, string>> {
		try {
			const json = await Bun.file(pkgJsonPath).json();
			return (json.dependencies as Record<string, string>) ?? {};
		} catch (err) {
			if (isEnoent(err)) return {};
			throw err;
		}
	}

	async #removeDependencyEntry(pkgJsonPath: string, name: string): Promise<void> {
		const pkgJson: { dependencies?: Record<string, string>; [key: string]: unknown } =
			await Bun.file(pkgJsonPath).json();
		if (!pkgJson.dependencies || !(name in pkgJson.dependencies)) {
			return;
		}
		delete pkgJson.dependencies[name];
		await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
	}

	#collectInstalledNames(deps: Record<string, string>, config: PluginRuntimeConfig): Set<string> {
		const installedNames = new Set<string>();
		for (const name of Object.keys(deps)) {
			installedNames.add(name);
		}
		for (const name of Object.keys(config.plugins)) {
			installedNames.add(name);
		}
		return installedNames;
	}
	async #collectMarketplaceRuntimePackageRealpaths(): Promise<Map<string, Set<string>>> {
		const registry = await readInstalledPluginsRegistry(getInstalledPluginsRegistryPath());
		const packageRealpaths = new Map<string, Set<string>>();
		await Promise.all(
			Object.entries(registry.plugins).flatMap(([pluginId, entries]) =>
				entries.map(async entry => {
					if ((entry.scope ?? "user") !== "user") return;
					const packageJsonPath = path.join(entry.installPath, "package.json");
					const parsedId = parsePluginId(pluginId);
					let packageName = parsedId?.name ?? pluginId;
					try {
						const pkg: RuntimePackageJson = await Bun.file(packageJsonPath).json();
						if (typeof pkg.name === "string" && pkg.name.length > 0) {
							packageName = pkg.name;
						}
					} catch (err) {
						if (!isEnoent(err)) {
							logger.debug("Failed to inspect marketplace plugin package path", {
								path: entry.installPath,
								error: String(err),
							});
							return;
						}
					}

					try {
						const installRealpath = await fs.promises.realpath(entry.installPath);
						const realpaths = packageRealpaths.get(packageName) ?? new Set<string>();
						realpaths.add(installRealpath);
						packageRealpaths.set(packageName, realpaths);
					} catch (err) {
						if (isEnoent(err)) return;
						throw err;
					}
				}),
			),
		);
		return packageRealpaths;
	}

	async #isMarketplaceRuntimeLink(
		name: string,
		deps: Record<string, string>,
		marketplaceRuntimeRealpaths: Map<string, Set<string>>,
		pluginPath: string,
	): Promise<boolean> {
		if (name in deps) return false;
		const realpaths = marketplaceRuntimeRealpaths.get(name);
		if (!realpaths) return false;
		try {
			return realpaths.has(await fs.promises.realpath(pluginPath));
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	async #snapshotInstalledPackage(actualName: string | undefined): Promise<PluginPackageSnapshot | null> {
		if (!actualName) {
			return null;
		}
		const packagePath = path.join(getPluginsNodeModules(), actualName);
		try {
			await fs.promises.lstat(packagePath);
		} catch (err) {
			if (isEnoent(err)) {
				return null;
			}
			throw err;
		}

		const backupRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "veyyon-plugin-backup-"));
		const backupPath = path.join(backupRoot, "package");
		await fs.promises.cp(packagePath, backupPath, { recursive: true, verbatimSymlinks: true });
		return { actualName, packagePath, backupRoot, backupPath };
	}

	async #cleanupSnapshot(snapshot: PluginPackageSnapshot | null): Promise<void> {
		if (!snapshot) {
			return;
		}
		try {
			await fs.promises.rm(snapshot.backupRoot, { recursive: true, force: true });
		} catch (err) {
			logger.warn("Failed to remove plugin install backup", { plugin: snapshot.actualName, error: String(err) });
		}
	}

	async #rollbackFailedInstall(
		actualName: string | undefined,
		packageJsonBefore: string,
		bunLockBefore: string | null,
		snapshot: PluginPackageSnapshot | null,
	): Promise<void> {
		await Bun.write(getPluginsPackageJson(), packageJsonBefore);

		const bunLockPath = path.join(getPluginsDir(), "bun.lock");
		if (bunLockBefore === null) {
			await fs.promises.rm(bunLockPath, { force: true });
		} else {
			await Bun.write(bunLockPath, bunLockBefore);
		}

		if (!actualName) {
			return;
		}
		const packagePath = path.join(getPluginsNodeModules(), actualName);
		await fs.promises.rm(packagePath, { recursive: true, force: true });
		if (!snapshot) {
			return;
		}
		await fs.promises.mkdir(path.dirname(snapshot.packagePath), { recursive: true });
		await fs.promises.cp(snapshot.backupPath, snapshot.packagePath, { recursive: true, verbatimSymlinks: true });
	}

	async #validateInstalledExtensions(plugin: InstalledPlugin): Promise<void> {
		const declaredEntries = resolvePluginManifestEntries(plugin, "extensions");
		if (declaredEntries.length === 0) {
			return;
		}

		const errors: string[] = [];
		const loadable: string[] = [];
		for (const { entry, resolvedPath } of declaredEntries) {
			if (resolvedPath === null) {
				errors.push(`${entry}: declared extension entry not found on disk`);
			} else {
				loadable.push(resolvedPath);
			}
		}

		if (loadable.length > 0) {
			installLegacyPiSpecifierShim();
			for (const extensionPath of loadable) {
				try {
					const module = await withExitGuard(() => loadLegacyPiModule(extensionPath));
					if (!hasExtensionFactoryExport(module)) {
						errors.push(`${extensionPath}: extension does not export a valid factory function`);
					}
				} catch (err) {
					const message = errorMessage(err);
					errors.push(`${extensionPath}: ${message}`);
				}
			}
		}

		if (errors.length > 0) {
			throw new Error(
				`The plugin ${plugin.name} declares extensions that do not load, so the install was rolled back ` +
					`and nothing changed:\n${errors.join("\n")}\n` +
					"Fix: report this to the plugin's author; there is no local repair for a broken extension entry.",
			);
		}
	}

	async install(specString: string, options: InstallOptions = {}): Promise<InstalledPlugin> {
		const spec = parsePluginSpec(specString);
		const gitSource = parseGitUrl(spec.packageName);
		if (gitSource) {
			validateGitSpec(spec.packageName);
		} else {
			validatePackageName(spec.packageName);
		}

		await this.#ensurePackageJson();

		const packageInstallSpec = gitSource ? gitInstallSpec(spec.packageName, gitSource) : spec.packageName;

		if (options.dryRun) {
			return await this.#resolveDryRun(spec, packageInstallSpec);
		}
		const pkgJsonPath = getPluginsPackageJson();
		const packageJsonBefore = await Bun.file(pkgJsonPath).text();
		const bunLockPath = path.join(getPluginsDir(), "bun.lock");
		let bunLockBefore: string | null;
		try {
			bunLockBefore = await Bun.file(bunLockPath).text();
		} catch (err) {
			if (!isEnoent(err)) throw err;
			bunLockBefore = null;
		}
		const depsBefore = await this.#readDeps(pkgJsonPath);
		const existingActualName = gitSource
			? findGitPackageName(gitSource, depsBefore)
			: extractPackageName(spec.packageName);
		const packageSnapshot = await this.#snapshotInstalledPackage(existingActualName);

		let actualName: string | undefined;
		try {
			if (gitSource && existingActualName) {
				const installedSource = parseGitUrl(depsBefore[existingActualName] ?? "");
				if (installedSource && installedSource.ref !== gitSource.ref) {
					await this.#removeDependencyEntry(pkgJsonPath, existingActualName);
				}
			}

			const installProc = Bun.spawn(["bun", "install", packageInstallSpec], {
				cwd: getPluginsDir(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			adoptIntoPrimarySessionCpuBudget(installProc.pid);
			const [installExit, , installStderr] = await Promise.all([
				installProc.exited,
				readPipeText(installProc.stdout),
				readPipeText(installProc.stderr),
			]);
			if (installExit !== 0) {
				throw new Error(
					`\`bun install\` failed in ${getPluginsDir()}, so the plugin is not installed: ${installStderr}. ` +
						"Fix: read that output; a network failure, a version that does not exist, and a missing `bun` " +
						"on PATH all land here.",
				);
			}
			if (gitSource) {
				const depsAfter = await this.#readDeps(pkgJsonPath);
				let resolved: string | undefined;
				for (const key of Object.keys(depsAfter)) {
					if (!(key in depsBefore)) {
						resolved = key;
						break;
					}
				}
				if (!resolved) {
					resolved = findGitPackageName(gitSource, depsAfter);
				}
				if (!resolved) {
					throw new Error(
						`${spec.packageName} installed, but no new entry appeared in ${getPluginsPackageJson()}, so ` +
							"veyyon cannot tell which package to enable and the install was rolled back. " +
							"Fix: run `veyyon plugin doctor` to see the current state, then install again.",
					);
				}
				actualName = resolved;
			} else {
				actualName = extractPackageName(spec.packageName);
			}

			if (gitSource && existingActualName) {
				await refreshBunGitCache(gitSource, getPluginsDir());
				const updateProc = Bun.spawn(["bun", "update", actualName], {
					cwd: getPluginsDir(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					windowsHide: true,
				});
				adoptIntoPrimarySessionCpuBudget(updateProc.pid);
				const [updateExit, , updateStderr] = await Promise.all([
					updateProc.exited,
					readPipeText(updateProc.stdout),
					readPipeText(updateProc.stderr),
				]);
				if (updateExit !== 0) {
					throw new Error(
						`\`bun update ${actualName}\` failed, so the plugin stays pinned to its previous commit: ` +
							`${updateStderr}. Fix: read that output, then run \`veyyon plugin install\` again with the ` +
							"same source to retry.",
					);
				}
			}

			const pkgPath = path.join(getPluginsNodeModules(), actualName, "package.json");
			let pkg: { name: string; version: string } & ManifestHolder<PluginManifest>;
			try {
				pkg = await Bun.file(pkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					throw new Error(
						`The plugin installed but has no package.json at ${pkgPath}, so its manifest cannot be read ` +
							"and the install was rolled back. " +
							"Fix: report this to the plugin's author; the published package is incomplete.",
					);
				}
				throw err;
			}
			const manifest: PluginManifest = manifestFromPackageJson(pkg) || { version: pkg.version };
			manifest.version = pkg.version;

			let enabledFeatures: string[] | null = null;
			if (spec.features === "*") {
				enabledFeatures = manifest.features ? Object.keys(manifest.features) : null;
			} else if (Array.isArray(spec.features)) {
				if (spec.features.length > 0) {
					if (manifest.features) {
						for (const feat of spec.features) {
							if (!(feat in manifest.features)) {
								throw new Error(
									`${actualName} has no feature named "${feat}", so the install was rolled back. ` +
										`Fix: it offers ${Object.keys(manifest.features).join(", ")}; pass one of those.`,
								);
							}
						}
					}
					enabledFeatures = spec.features;
				} else {
					enabledFeatures = [];
				}
			}

			const installedPlugin: InstalledPlugin = {
				name: pkg.name,
				version: pkg.version,
				path: path.join(getPluginsNodeModules(), actualName),
				manifest,
				enabledFeatures,
				enabled: true,
			};

			await this.#validateInstalledExtensions(installedPlugin);

			const config = await this.#ensureConfigLoaded();
			config.plugins[pkg.name] = {
				version: pkg.version,
				enabledFeatures,
				enabled: true,
			};
			await this.#saveRuntimeConfig();

			return installedPlugin;
		} catch (err) {
			try {
				await this.#rollbackFailedInstall(
					actualName ?? existingActualName,
					packageJsonBefore,
					bunLockBefore,
					packageSnapshot,
				);
			} catch (rollbackErr) {
				const message = errorMessage(err);
				const rollbackMessage = errorMessage(rollbackErr);
				throw new Error(
					`${message}\nThe rollback then failed too, so the plugins directory is in a mixed state: ` +
						`${rollbackMessage}. Fix: run \`veyyon plugin doctor --fix\` to reinstall from the manifest.`,
				);
			}
			throw err;
		} finally {
			await this.#cleanupSnapshot(packageSnapshot);
		}
	}

	async #resolveDryRun(spec: ParsedPluginSpec, packageInstallSpec: string): Promise<InstalledPlugin> {
		const proc = Bun.spawn(["bun", "install", packageInstallSpec, "--dry-run"], {
			cwd: getPluginsDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		adoptIntoPrimarySessionCpuBudget(proc.pid);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			readPipeText(proc.stdout),
			readPipeText(proc.stderr),
		]);
		if (exitCode !== 0) {
			throw new Error(
				`${spec.packageName} cannot be installed, so the dry run failed: ${stderr}. ` +
					"Fix: read that output; a name that was never published, a version that does not exist, " +
					"a private or missing repository, and a missing `bun` on PATH all land here.",
			);
		}
		const resolved = parseDryRunResolution(stdout);
		return {
			name: resolved?.name ?? extractPackageName(spec.packageName),
			version: resolved?.version ?? "",
			path: "",
			manifest: { version: resolved?.version ?? "" },
			enabledFeatures: spec.features === "*" ? null : (spec.features as string[] | null),
			enabled: true,
		};
	}

	async uninstall(name: string): Promise<void> {
		validatePackageName(name);
		await this.#ensurePackageJson();

		const manifest = Bun.file(getPluginsPackageJson());
		const deps = (await manifest.exists()) ? ((await manifest.json()).dependencies ?? {}) : {};
		const config = await this.#ensureConfigLoaded();
		if (!(name in deps) && !(name in config.plugins)) {
			throw new Error(`Plugin ${name} is not installed. Run \`veyyon plugin list\` to see installed plugins.`);
		}

		if (!(name in deps)) {
			await this.#unlinkPluginPath(name);
			delete config.plugins[name];
			delete config.settings[name];
			await this.#saveRuntimeConfig();
			return;
		}

		const proc = Bun.spawn(["bun", "uninstall", name], {
			cwd: getPluginsDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		adoptIntoPrimarySessionCpuBudget(proc.pid);

		const [exitCode, , uninstallStderr] = await Promise.all([
			proc.exited,
			readPipeText(proc.stdout),
			readPipeText(proc.stderr),
		]);
		if (exitCode !== 0) {
			throw new Error(
				`\`bun uninstall ${name}\` failed in ${getPluginsDir()}, so the plugin is still installed` +
					`${uninstallStderr.trim() ? `: ${uninstallStderr.trim()}` : "."} ` +
					"Fix: read that output, then run `veyyon plugin doctor` to see the current state.",
			);
		}

		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
	}

	async #unlinkPluginPath(name: string): Promise<void> {
		const linkPath = path.join(getPluginsNodeModules(), name);
		try {
			const stats = await fs.promises.lstat(linkPath);
			if (stats.isSymbolicLink() || stats.isFile()) {
				await fs.promises.unlink(linkPath);
			} else if (stats.isDirectory()) {
				await fs.promises.rm(linkPath, { recursive: true, force: true });
			}
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	async list(): Promise<InstalledPlugin[]> {
		const pkgJsonPath = getPluginsPackageJson();
		let deps: Record<string, string> = {};
		try {
			const pkg: { dependencies?: Record<string, string> } = await Bun.file(pkgJsonPath).json();
			deps = pkg.dependencies ?? {};
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		const [projectOverrides, config, marketplaceRuntimeRealpaths] = await Promise.all([
			this.#loadProjectOverrides(),
			this.#ensureConfigLoaded(),
			this.#collectMarketplaceRuntimePackageRealpaths(),
		]);
		const plugins: InstalledPlugin[] = [];
		const installedNames = this.#collectInstalledNames(deps, config);
		for (const name of installedNames) {
			const pluginPath = path.join(getPluginsNodeModules(), name);
			if (await this.#isMarketplaceRuntimeLink(name, deps, marketplaceRuntimeRealpaths, pluginPath)) continue;
			const pluginPkgPath = path.join(pluginPath, "package.json");
			let pluginPkg: { version: string } & ManifestHolder<PluginManifest>;
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			const manifest: PluginManifest = manifestFromPackageJson(pluginPkg) || { version: pluginPkg.version };
			manifest.version = pluginPkg.version;

			const runtimeState = config.plugins[name] || {
				version: pluginPkg.version,
				enabledFeatures: null,
				enabled: true,
			};

			const isDisabledInProject = projectOverrides.disabled?.includes(name) ?? false;
			const projectFeatures = projectOverrides.features?.[name];

			plugins.push({
				name,
				version: pluginPkg.version,
				path: pluginPath,
				manifest,
				enabledFeatures: projectFeatures ?? runtimeState.enabledFeatures,
				enabled: runtimeState.enabled && !isDisabledInProject,
			});
		}

		return plugins;
	}

	async link(localPath: string): Promise<InstalledPlugin> {
		const absolutePath = path.resolve(this.#cwd, localPath);

		const pkgFilePath = path.join(absolutePath, "package.json");
		let pkg: { name?: string; version: string } & ManifestHolder<PluginManifest>;
		try {
			pkg = await Bun.file(pkgFilePath).json();
		} catch (err) {
			if (isEnoent(err))
				throw new Error(
					`No package.json at ${absolutePath}, so there is nothing to link. ` +
						"Fix: point `veyyon plugin link` at the plugin's own root, the directory holding its package.json.",
				);
			throw err;
		}
		if (!pkg.name) {
			throw new Error(
				`The package.json at ${absolutePath} has no \`name\`, so the plugin cannot be registered under any ` +
					"name. Fix: add a `name` field to it.",
			);
		}

		await this.#ensurePluginsDir();

		const linkPath = path.join(getPluginsNodeModules(), pkg.name);

		if (pkg.name.startsWith("@")) {
			const scopeDir = path.join(getPluginsNodeModules(), pkg.name.split("/")[0]);
			await fs.promises.mkdir(scopeDir, { recursive: true });
		}

		await this.#unlinkPluginPath(pkg.name);

		await fs.promises.symlink(absolutePath, linkPath);

		const manifest: PluginManifest = manifestFromPackageJson(pkg) || { version: pkg.version };
		manifest.version = pkg.version;

		const config = await this.#ensureConfigLoaded();
		config.plugins[pkg.name] = {
			version: pkg.version,
			enabledFeatures: null,
			enabled: true,
		};
		await this.#saveRuntimeConfig();

		return {
			name: pkg.name,
			version: pkg.version,
			path: absolutePath,
			manifest,
			enabledFeatures: null,
			enabled: true,
		};
	}

	async setEnabled(name: string, enabled: boolean): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(pluginNotInRuntimeConfigMessage(name));
		}
		config.plugins[name].enabled = enabled;
		await this.#saveRuntimeConfig();
	}

	async getEnabledFeatures(name: string): Promise<string[] | null> {
		const config = await this.#ensureConfigLoaded();
		return config.plugins[name]?.enabledFeatures ?? null;
	}

	async setEnabledFeatures(name: string, features: string[] | null): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(pluginNotInRuntimeConfigMessage(name));
		}

		if (features && features.length > 0) {
			const plugins = await this.list();
			const plugin = plugins.find(p => p.name === name);
			if (plugin?.manifest.features) {
				for (const feat of features) {
					if (!(feat in plugin.manifest.features)) {
						throw new Error(
							`${name} has no feature named "${feat}", so nothing was changed. ` +
								`Fix: it offers ${Object.keys(plugin.manifest.features).join(", ")}; pass one of those.`,
						);
					}
				}
			}
		}

		config.plugins[name].enabledFeatures = features;
		await this.#saveRuntimeConfig();
	}

	async getPluginSettings(name: string): Promise<Record<string, unknown>> {
		const config = await this.#ensureConfigLoaded();
		const global = config.settings[name] || {};
		const projectOverrides = await this.#loadProjectOverrides();
		const project = projectOverrides.settings?.[name] || {};

		return { ...global, ...project };
	}

	async setPluginSetting(name: string, key: string, value: unknown): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.settings[name]) {
			config.settings[name] = {};
		}
		config.settings[name][key] = value;
		await this.#saveRuntimeConfig();
	}

	async deletePluginSetting(name: string, key: string): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (config.settings[name]) {
			delete config.settings[name][key];
			await this.#saveRuntimeConfig();
		}
	}

	async doctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
		const checks: DoctorCheck[] = [];

		const pluginsDir = getPluginsDir();
		const pluginsDirState = await pathState(pluginsDir);
		checks.push({
			name: "plugins_directory",
			status: pluginsDirState === "unreadable" ? "error" : "ok",
			message:
				pluginsDirState === "present"
					? `Found at ${pluginsDir}`
					: pluginsDirState === "absent"
						? "Not created yet (no plugins installed)"
						: `Exists at ${pluginsDir} but could not be read, so no plugin can load. Check its permissions and whether its filesystem is mounted.`,
		});

		const pkgJsonPath = getPluginsPackageJson();
		let pkg: { dependencies?: Record<string, string> };
		let manifestProblem: string | undefined;
		let hasPkgJson = true;
		try {
			pkg = await Bun.file(pkgJsonPath).json();
		} catch (err) {
			pkg = {};
			hasPkgJson = false;
			if (!isEnoent(err)) {
				manifestProblem = errorMessage(err);
			}
		}
		const linkedOnlyCount = hasPkgJson ? 0 : Object.keys((await this.#ensureConfigLoaded()).plugins).length;
		checks.push({
			name: "package_manifest",
			status: manifestProblem === undefined ? "ok" : "error",
			message:
				manifestProblem === undefined
					? hasPkgJson
						? "Found"
						: linkedOnlyCount > 0
							? `Not created yet (${linkedOnlyCount} linked plugin${linkedOnlyCount === 1 ? "" : "s"}, no npm install yet)`
							: "Not created yet (no plugins installed)"
					: `${pkgJsonPath} could not be read (${manifestProblem}), so no plugin can be resolved. Fix or delete the file and reinstall.`,
		});

		const nodeModulesPath = getPluginsNodeModules();
		const nodeModulesState = await pathState(nodeModulesPath);
		const hasNodeModules = nodeModulesState === "present";
		checks.push({
			name: "node_modules",
			status: hasNodeModules ? "ok" : nodeModulesState === "unreadable" || hasPkgJson ? "error" : "ok",
			message: hasNodeModules
				? "Found"
				: nodeModulesState === "unreadable"
					? `Exists at ${nodeModulesPath} but could not be read, so no installed plugin can load. Check its permissions.`
					: hasPkgJson
						? // NOT `npm install`. Every install path in this file spawns `bun
							"Missing, so no installed plugin can load. Fix: run `veyyon plugin doctor --fix`, which " +
							"reinstalls from the manifest."
						: // "Not needed" is a claim about the dependency list, so it may only be made when that
							manifestProblem === undefined
							? "Not needed (no plugins installed)"
							: `Not present. Whether an install is needed is unknown, because ${pkgJsonPath} could not be read.`,
		});

		const deps = pkg.dependencies || {};
		const [config, marketplaceRuntimeRealpaths] = await Promise.all([
			this.#ensureConfigLoaded().catch(err => {
				checks.push({
					name: "plugin_config",
					status: "error",
					message:
						`The plugin runtime config could not be read (${errorMessage(err)}), so no plugin's enabled ` +
						"state is known and every plugin below is reported from the manifest alone. " +
						"Fix: check that file's permissions, or delete it and re-enable your plugins with " +
						"`veyyon plugin enable <name>`.",
				});
				return normalizePluginRuntimeConfig({});
			}),
			this.#collectMarketplaceRuntimePackageRealpaths().catch(err => {
				checks.push({
					name: "installed_registry",
					status: "error",
					message: `${getInstalledPluginsRegistryPath()} could not be read (${errorMessage(err)}), so a marketplace plugin may be reported as missing when it is installed. Check the plugins directory's permissions.`,
				});
				return new Map<string, Set<string>>();
			}),
		]);
		const installedNames = this.#collectInstalledNames(deps, config);

		for (const name of installedNames) {
			const pluginPath = path.join(nodeModulesPath, name);
			if (await this.#isMarketplaceRuntimeLink(name, deps, marketplaceRuntimeRealpaths, pluginPath)) continue;
			const pluginPkgPath = path.join(pluginPath, "package.json");
			const fromDependencies = name in deps;

			let pluginPkg: { version: string; description?: string } & ManifestHolder<PluginManifest>;
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					if (!(await pathExists(pluginPath, `the installed plugin ${name}`))) {
						if (fromDependencies) {
							const fixed = options.fix ? await this.#fixMissingPlugin() : false;
							checks.push({
								name: `plugin:${name}`,
								status: "error",
								message:
									"In the manifest but missing from node_modules, so it cannot load. " +
									"Fix: run `veyyon plugin doctor --fix`, which reinstalls from the manifest.",
								fixed,
							});
						} else {
							const fixed = options.fix ? await this.#removeOrphanedConfig(name) : false;
							checks.push({
								name: `orphan:${name}`,
								status: "warning",
								message: "Plugin in config but not installed",
								fixed,
							});
						}
					} else {
						checks.push({
							name: `plugin:${name}`,
							status: "error",
							message: "Missing package.json",
						});
					}
					continue;
				}
				throw err;
			}
			const manifest: PluginManifest | undefined = manifestFromPackageJson(pluginPkg);
			const hasManifest = manifest !== undefined;

			checks.push({
				name: `plugin:${name}`,
				status: hasManifest ? "ok" : "warning",
				message: hasManifest
					? `v${pluginPkg.version}${pluginPkg.description ? ` - ${pluginPkg.description}` : ""}`
					: `v${pluginPkg.version} - No veyyon/omp/pi manifest (not a veyyon plugin)`,
			});

			if (manifest?.tools) {
				const toolsPath = path.join(pluginPath, manifest.tools);
				if (!(await pathExists(toolsPath, `the tools entry for plugin ${name}`))) {
					checks.push({
						name: `plugin:${name}:tools`,
						status: "error",
						message: `Tools entry "${manifest.tools}" not found`,
					});
				}
			}

			if (manifest?.hooks) {
				const hooksPath = path.join(pluginPath, manifest.hooks);
				if (!(await pathExists(hooksPath, `the hooks entry for plugin ${name}`))) {
					checks.push({
						name: `plugin:${name}:hooks`,
						status: "error",
						message: `Hooks entry "${manifest.hooks}" not found`,
					});
				}
			}

			if (manifest?.extensions) {
				for (const extensionPath of manifest.extensions) {
					const resolvedExtensionPath = path.join(pluginPath, extensionPath);
					if (!(await pathExists(resolvedExtensionPath, `an extension entry for plugin ${name}`))) {
						checks.push({
							name: `plugin:${name}:extension:${extensionPath}`,
							status: "error",
							message: `Extension entry "${extensionPath}" not found`,
						});
					}
				}
			}

			const runtimeState = config.plugins[name];
			if (runtimeState?.enabledFeatures && manifest?.features) {
				for (const feat of runtimeState.enabledFeatures) {
					if (!(feat in manifest.features)) {
						const fixed = options.fix ? await this.#removeInvalidFeature(name, feat) : false;
						checks.push({
							name: `plugin:${name}:feature:${feat}`,
							status: "warning",
							message: `Enabled feature "${feat}" not in manifest`,
							fixed,
						});
					}
				}
			}
		}

		return checks;
	}

	async #fixMissingPlugin(): Promise<boolean> {
		const cwd = getPluginsDir();
		try {
			const proc = Bun.spawn(["bun", "install"], {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			adoptIntoPrimarySessionCpuBudget(proc.pid);
			const [exit, , stderr] = await Promise.all([
				proc.exited,
				readPipeText(proc.stdout),
				readPipeText(proc.stderr),
			]);
			if (exit !== 0) {
				logger.warn("Reinstalling plugins failed; the missing plugin was not restored", {
					cwd,
					exitCode: exit,
					stderr: stderr.trim().slice(-2000),
				});
			}
			return exit === 0;
		} catch (err) {
			logger.warn("Reinstalling plugins could not be started; the missing plugin was not restored", {
				cwd,
				error: errorMessage(err),
			});
			return false;
		}
	}

	async #removeInvalidFeature(name: string, feat: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		const state = config.plugins[name];
		if (state?.enabledFeatures) {
			state.enabledFeatures = state.enabledFeatures.filter(f => f !== feat);
			await this.#saveRuntimeConfig();
			return true;
		}
		return false;
	}

	async #removeOrphanedConfig(name: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
		return true;
	}
}

export interface PluginSettingValidationResult {
	valid: boolean;
	error?: string;
}

export function validateSetting(value: unknown, schema: PluginSettingSchema): PluginSettingValidationResult {
	switch (schema.type) {
		case "string":
			if (typeof value !== "string") {
				return { valid: false, error: "Expected string" };
			}
			break;

		case "number":
			if (typeof value !== "number" || Number.isNaN(value)) {
				return { valid: false, error: "Expected number" };
			}
			if (schema.min !== undefined && value < schema.min) {
				return { valid: false, error: `Must be >= ${schema.min}` };
			}
			if (schema.max !== undefined && value > schema.max) {
				return { valid: false, error: `Must be <= ${schema.max}` };
			}
			break;

		case "boolean":
			if (typeof value !== "boolean") {
				return { valid: false, error: "Expected boolean" };
			}
			break;

		case "enum":
			if (!schema.values.includes(String(value))) {
				return { valid: false, error: `Must be one of: ${schema.values.join(", ")}` };
			}
			break;
	}

	return { valid: true };
}

export function parseSettingValue(valueStr: string, schema: PluginSettingSchema): unknown {
	switch (schema.type) {
		case "number":
			return Number(valueStr);

		case "boolean":
			return valueStr === "true" || valueStr === "yes" || valueStr === "1";
		default:
			return valueStr;
	}
}
