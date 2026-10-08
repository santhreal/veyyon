/**
 * Configures ArkType jitless for the process, as the CLI entry does. Import it before any module
 * that imports `arktype`: ArkType reads the setting when `arktype` first evaluates.
 */
import { configure } from "arktype/config";

configure({ jitless: true });
