import { vscodeMarketplaceDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleVscodeMarketplace: SpecialHandler = createPackageRegistryHandler(
	vscodeMarketplaceDeclaration,
	"handleVscodeMarketplace",
);
