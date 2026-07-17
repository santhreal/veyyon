import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@veyyon/pi-utils";
import { extractPackageName, validatePackageName } from "./parser";
import type { InstalledPlugin } from "./types";

const PLUGINS_DIR = path.join(getAgentDir(), "plugins");

// Valid npm package name pattern (scoped and unscoped)
/**
 * Validate package name to prevent command injection
 */
/**
 * Ensure the plugins directory exists
 */
async function ensurePluginsDir(): Promise<void> {
	await fs.mkdir(PLUGINS_DIR, { recursive: true });
	await fs.mkdir(path.join(PLUGINS_DIR, "node_modules"), { recursive: true });
}

export async function installPlugin(packageName: string): Promise<InstalledPlugin> {
	// Validate package name to prevent command injection
	validatePackageName(packageName);

	// Ensure plugins directory exists
	await ensurePluginsDir();

	// Initialize package.json if it doesn't exist
	const pkgJsonPath = path.join(PLUGINS_DIR, "package.json");
	const pkgJson = Bun.file(pkgJsonPath);
	if (!(await pkgJson.exists())) {
		await pkgJson.write(JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2));
	}

	// Run npm install in plugins directory
	const proc = Bun.spawn(["bun", "install", packageName], {
		cwd: PLUGINS_DIR,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	// Drain both pipes concurrently with proc.exited to avoid a pipe-buffer
	// deadlock if bun install floods stdout/stderr.
	const [exitCode, , stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to install ${packageName}: ${stderr}`);
	}

	// Extract the actual package name (without version specifier) for path lookup
	const actualName = extractPackageName(packageName);

	// Read the installed package's package.json
	const pkgPath = path.join(PLUGINS_DIR, "node_modules", actualName, "package.json");
	const pkgFile = Bun.file(pkgPath);
	if (!(await pkgFile.exists())) {
		throw new Error(`Package installed but package.json not found at ${pkgPath}`);
	}

	const pkg = await pkgFile.json();

	return {
		name: pkg.name,
		version: pkg.version,
		path: path.join(PLUGINS_DIR, "node_modules", actualName),
		manifest: pkg.omp || pkg.pi || { version: pkg.version },
		enabledFeatures: null,
		enabled: true,
	};
}

export async function uninstallPlugin(name: string): Promise<void> {
	// Validate package name
	validatePackageName(name);

	await ensurePluginsDir();

	const proc = Bun.spawn(["bun", "uninstall", name], {
		cwd: PLUGINS_DIR,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	const [exitCode] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to uninstall ${name}`);
	}
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
	const pkgJsonPath = Bun.file(path.join(PLUGINS_DIR, "package.json"));
	if (!(await pkgJsonPath.exists())) {
		return [];
	}

	const pkg = await pkgJsonPath.json();
	const deps = pkg.dependencies || {};

	const plugins: InstalledPlugin[] = [];
	for (const [name, _version] of Object.entries(deps)) {
		const pluginPath = path.join(PLUGINS_DIR, "node_modules", name);
		const fpkg = Bun.file(path.join(pluginPath, "package.json"));
		if (await fpkg.exists()) {
			const pkg = await fpkg.json();
			plugins.push({
				name,
				version: pkg.version,
				path: pluginPath,
				manifest: pkg.omp || pkg.pi || { version: pkg.version },
				enabledFeatures: null,
				enabled: true,
			});
		}
	}

	return plugins;
}
