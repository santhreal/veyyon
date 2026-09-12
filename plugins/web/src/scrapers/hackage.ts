import { hackageDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handleHackage: SpecialHandler = createPackageRegistryHandler(hackageDeclaration, "handleHackage");
