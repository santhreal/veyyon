import { fdroidDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleFdroid: SpecialHandler = createPackageRegistryHandler(fdroidDeclaration, "handleFdroid");
