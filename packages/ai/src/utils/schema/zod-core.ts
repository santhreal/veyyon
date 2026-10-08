/**
 * Installs Zod's core JSON Schema converter for `zodToWireSchema`.
 *
 * Imported for its effect by the barrels that hand Zod to code outside this repository
 * (`@veyyon/ai` and `@veyyon/coding-agent`), never by a module the CLI loads at startup: the
 * compiled binary loads this module's chunk, and Zod's core with it, only when one of those
 * barrels is loaded.
 */
import { toJSONSchema } from "zod/v4/core";
import { installZodCoreConverter } from "./wire";

installZodCoreConverter(toJSONSchema);
