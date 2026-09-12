import { jetbrainsMarketplaceDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleJetBrainsMarketplace: SpecialHandler = createPackageRegistryHandler(
	jetbrainsMarketplaceDeclaration,
	"handleJetBrainsMarketplace",
);
