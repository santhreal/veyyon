declare module "veyyon-legacy-pi-modules" {
	/** Per key, a function that builds the export record of a host module the compiled binary retains for legacy extensions. */
	export const BUNDLED_PI_MODULES: Readonly<Record<string, () => Readonly<Record<string, unknown>>>>;
}
