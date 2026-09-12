import { mavenDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleMaven: SpecialHandler = createPackageRegistryHandler(mavenDeclaration, "handleMaven");
