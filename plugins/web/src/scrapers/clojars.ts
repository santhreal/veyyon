import { clojarsDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleClojars: SpecialHandler = createPackageRegistryHandler(clojarsDeclaration, "handleClojars");
