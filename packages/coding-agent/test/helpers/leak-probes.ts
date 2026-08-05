/**
 * Leak probes this package contributes to the process-global leak tracer.
 *
 * WHY IT LIVES HERE RATHER THAN IN THE TRACER. `packages/utils/test/helpers/
 * global-state-leak-probes.ts` probes `@veyyon/utils` and nothing else, on purpose:
 * a diagnostic that imports the thing it is supposed to be observing can initialise
 * that state itself, and dragging a heavy package into every traced process is how
 * that happens. So the dependency points the other way. The tracer exposes
 * `registerLeakProbe` and knows nothing about this package; `scripts/find-test-leaks.ts`
 * preloads `packages/<pkg>/test/helpers/leak-probes.ts` when it traces a file under
 * `packages/<pkg>`, so any package can contribute a probe without the tracer growing
 * a case for it.
 *
 * WHAT THESE TWO CATCH. `initializeWithSettings` writes three module-globals in
 * `src/capability/index.ts`, and `resetSettingsForTest` clears none of them. Two are
 * observable and neither had a probe, so the tracer called a file clean while it left
 * the registry reconfigured for every file after it. That is not hypothetical: three
 * suites left `importForeignConfig` ON when the shipped default is OFF, so later files
 * ambiently loaded the CLAUDE.md and .cursor rules veyyon is supposed to ignore, and
 * the tracer reported all three as clean.
 *
 * The third field, the captured `Settings` reference, is deliberately not probed: it
 * is an object identity rather than a comparable value, and the read it fed
 * (`disabledExtensions`) now resolves through the canonical settings slot instead.
 */
import { getDisabledProviders, isForeignConfigImportEnabled } from "@veyyon/coding-agent/capability";
import { registerLeakProbe } from "../../../utils/test/helpers/global-state-leak-tracer";

/**
 * The foreign-config master gate. Default OFF. A suite that opens it and does not
 * close it makes every later file discover other tools' configuration ambiently,
 * which is a behaviour and privacy change that lands in someone else's file.
 */
registerLeakProbe("importForeignConfig", () => String(isForeignConfigImportEnabled()));

/**
 * The explicitly disabled provider set. `disableProvider` and `setDisabledProviders`
 * write it with no restore of their own, so an unbalanced call silently removes a
 * provider from every later file's discovery.
 */
registerLeakProbe("disabledProviders", () => getDisabledProviders().slice().sort().join(",") || "(none)");
