import { firefoxAddonsDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleFirefoxAddons: SpecialHandler = createPackageRegistryHandler(
	firefoxAddonsDeclaration,
	"handleFirefoxAddons",
);
