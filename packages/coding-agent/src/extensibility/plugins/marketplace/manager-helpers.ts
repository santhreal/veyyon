export const RUNTIME_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const MAX_RUNTIME_PACKAGE_NAME_LENGTH = 214;

export function marketplaceNotConfiguredMessage(name: string): string {
	return (
		`No marketplace named "${name}" is configured, so nothing could be read from it. ` +
		"Fix: run `veyyon plugin marketplace list` to see the configured ones, or " +
		"`veyyon plugin marketplace add <source>` to add this one."
	);
}

export function assertRuntimePackageName(name: string): string {
	if (name.length > MAX_RUNTIME_PACKAGE_NAME_LENGTH || !RUNTIME_PACKAGE_NAME_RE.test(name)) {
		throw new Error(
			`${JSON.stringify(name)} is not a usable package name for a marketplace plugin, so it was not installed. ` +
				`Fix: the marketplace's catalog has to name it in npm form (lowercase, optionally scoped, at most ` +
				`${MAX_RUNTIME_PACKAGE_NAME_LENGTH} characters); report it to whoever publishes that marketplace.`,
		);
	}
	return name;
}

export interface MarketplaceManagerOptions {
	marketplacesRegistryPath: string;
	installedRegistryPath: string;
	projectInstalledRegistryPath?: string;
	marketplacesCacheDir: string;
	pluginsCacheDir: string;
	clearPluginRootsCache?: (extraPaths?: readonly string[]) => void;
}
