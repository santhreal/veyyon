/**
 * @veyyon/evals — every model, harness and prompt evaluation in this repository.
 *
 * Five axes: suite × harness × config × prompt variant × model. `core` holds the
 * contracts and the registries, `run` plans and executes a cell matrix. The
 * members of each axis are reached at their own paths (`@veyyon/evals/suites/…`,
 * `@veyyon/evals/backends/…`, `@veyyon/evals/harnesses`), because three suites and
 * three backends collide on names like `TaskMetadata` and `CommandExecutor` and a
 * merged star would pick one at random.
 */

export { builtinBackends, registerAllBackends } from "./backends";
export * from "./core";
export { builtinHarnesses, registerBuiltinHarnesses } from "./harnesses";
export * from "./run";
export { builtinSuites, registerAllSuites } from "./suites";
