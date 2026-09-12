import { brewDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleBrew: SpecialHandler = createPackageRegistryHandler(brewDeclaration, "handleBrew");
