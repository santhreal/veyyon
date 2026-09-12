import { pubDevDeclaration } from "./declarations/package-registries";
import { createPackageRegistryHandler } from "./engine/package-registry";
import type { SpecialHandler } from "./types";

export const handlePubDev: SpecialHandler = createPackageRegistryHandler(pubDevDeclaration, "handlePubDev");
