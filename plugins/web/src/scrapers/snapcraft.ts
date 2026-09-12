import { snapcraftDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleSnapcraft: SpecialHandler = createPackageRegistryHandler(snapcraftDeclaration, "handleSnapcraft");
