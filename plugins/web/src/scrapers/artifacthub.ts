import { artifacthubDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleArtifactHub: SpecialHandler = createPackageRegistryHandler(
	artifacthubDeclaration,
	"handleArtifactHub",
);
