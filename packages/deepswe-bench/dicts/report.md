# Argot dictionary savings per DeepSWE task

Generated 2026-07-24T18:17:38.699Z by gen-dicts.ts (SDK generateDictFromRepo, default token budget).

Ranked by `typeable saving`: characters saved per emission across handles whose
expansion contains no whitespace. Prose handles (license text, fixture YAML, doc
URLs) repeat heavily in a repo and inflate the raw SDK estimate, but a coding
agent never retypes them. On the one run measured, every handle the model emitted
was whitespace-free and no prose handle ever was, so this column never misses a
string the model would have written. A near-zero value means the task cannot
demonstrate codec value at all, whatever the model does: exclude it before
spending a run on it, and confirm the exact ceiling post-run from the bench
report's Encode headroom section.

| task | handles | typeable handles | typeable saving (ch/emission) | dict tokens | raw SDK estimate (output tok) |
|---|---|---|---|---|---|
| opa-rego-rule-profiling | 10 | 6 | 2434 | 999 | 51826 |
| opa-template-string-reconstruction | 10 | 6 | 2434 | 999 | 51826 |
| gql-incremental-graphql-delivery | 3 | 1 | 1629 | 1000 | 1309 |
| go-git-worktree-merge-conflicts | 40 | 36 | 1220 | 999 | 26443 |
| arcane-drift-detection-baselines | 33 | 28 | 1006 | 999 | 16189 |
| sql-formatter-bigquery-pipe-formatting | 42 | 38 | 987 | 1000 | 4937 |
| goreleaser-retry-publish-auditing | 25 | 22 | 862 | 999 | 24194 |
| updo-policy-alerting | 34 | 26 | 858 | 999 | 2697 |
| scriggo-method-declarations | 30 | 24 | 836 | 999 | 6643 |
| pebble-durability-wait-apis | 27 | 25 | 798 | 998 | 31169 |
| effect-sse-httpapi-streaming | 68 | 64 | 707 | 998 | 32999 |
| happy-dom-abort-pending-body-reads | 30 | 28 | 679 | 995 | 19731 |
| happy-dom-deterministic-intersectionobserver | 30 | 28 | 679 | 995 | 19731 |
| prometheus-transactional-reload-status | 20 | 19 | 646 | 1000 | 37335 |
| prometheus-typed-label-sorting | 20 | 19 | 646 | 1000 | 37335 |
| expr-try-catch-errors | 36 | 24 | 632 | 1000 | 5708 |
| go-critic-doc-link-checker | 35 | 22 | 580 | 998 | 6094 |
| oxvg-structural-selector-preservation | 30 | 17 | 575 | 995 | 10407 |
| superjson-error-stack-serialization | 45 | 27 | 555 | 998 | 876 |
| actionlint-action-pinning-lint | 11 | 7 | 527 | 997 | 5514 |
| ytt-jsonpath-query-api | 33 | 21 | 504 | 995 | 10295 |
| geo-shapeindex-serialization | 25 | 14 | 480 | 1000 | 4964 |
| onedump-dump-encryption-pipeline | 20 | 15 | 443 | 999 | 2141 |
| task-task-graph-export | 20 | 14 | 413 | 999 | 4179 |
| query-persist-restored-query-state | 8 | 5 | 400 | 1000 | 13838 |
| ts-pattern-match-each | 19 | 8 | 397 | 999 | 1508 |
| scc-bounded-memory-spilling | 19 | 9 | 394 | 998 | 6052 |
| etree-xml-diff-patch | 35 | 10 | 373 | 998 | 1027 |
| bandit-incremental-cache-control | 41 | 14 | 370 | 1000 | 5669 |
| bandit-interprocedural-taint-checks | 41 | 14 | 370 | 1000 | 5669 |
| bandit-structured-nosec-directives | 41 | 14 | 370 | 1000 | 5669 |
| sqlfmt-create-table-ddl-formatting | 16 | 4 | 364 | 998 | 2377 |
| pest-character-class-coalescing | 25 | 10 | 361 | 999 | 7420 |
| drizzle-orm-window-function-builders | 41 | 37 | 358 | 1000 | 15689 |
| numba-stencil-boundary-modes | 40 | 9 | 352 | 998 | 9555 |
| dasel-html-document-format | 16 | 11 | 337 | 999 | 4578 |
| helm-array-merge-strategies | 27 | 15 | 309 | 997 | 25566 |
| helm-unified-manifest-stream | 27 | 15 | 309 | 997 | 25566 |
| go-genai-streamed-function-args | 18 | 11 | 248 | 999 | 3822 |
| kgateway-consistent-hash-policy | 15 | 6 | 239 | 1000 | 79385 |
| optique-conditional-option-dependencies | 34 | 13 | 237 | 1000 | 7565 |
| mnamer-daemon-watch-lifecycle | 9 | 2 | 218 | 998 | 1018 |
| dateutil-rfc5545-timezone-interop | 21 | 4 | 204 | 1000 | 1351 |
| termenv-preserve-ansi-resets | 18 | 7 | 194 | 999 | 1220 |
| valibot-recursive-schema-composition | 22 | 19 | 190 | 997 | 33368 |
| participle-grammar-conflict-analysis | 11 | 6 | 136 | 999 | 3425 |
| tengo-callable-instance-isolation | 31 | 6 | 133 | 996 | 2408 |
| tengo-destructuring-bindings | 31 | 6 | 133 | 996 | 2408 |
| pwntools-tube-multiplexing | 13 | 3 | 131 | 1000 | 20313 |
| kysely-window-grouping-helpers | 12 | 6 | 126 | 1000 | 8090 |
| ink-grid-box-layout | 10 | 7 | 118 | 1000 | 5063 |
| mobly-grouped-test-barriers | 31 | 3 | 116 | 1000 | 4573 |
| ofetch-per-origin-circuit-breaker | 25 | 1 | 116 | 996 | 1290 |
| csstree-shorthand-expansion-compression | 7 | 4 | 112 | 995 | 2039 |
| dynamodb-toolbox-conditional-attribute-requirements | 20 | 13 | 112 | 999 | 9939 |
| dynamodb-toolbox-lazy-recursive-schemas | 20 | 13 | 112 | 999 | 9939 |
| textual-kitty-key-phases | 27 | 5 | 105 | 1000 | 21892 |
| textual-richlog-follow-state | 27 | 5 | 105 | 1000 | 21911 |
| anko-default-function-arguments | 26 | 5 | 101 | 996 | 1818 |
| anko-typed-variable-bindings | 26 | 5 | 101 | 996 | 1818 |
| true-myth-iterable-collection-combinators | 14 | 3 | 101 | 994 | 1465 |
| fd-deterministic-multi-key-sorting | 15 | 4 | 99 | 994 | 1436 |
| narwhals-rolling-window-suite | 43 | 4 | 98 | 999 | 10263 |
| meriyah-explicit-resource-declarations | 16 | 8 | 96 | 1000 | 5068 |
| vulture-persistent-analysis-cache | 28 | 2 | 90 | 1000 | 1119 |
| wazero-multi-module-snapshots | 4 | 3 | 85 | 998 | 7074 |
| cliffy-config-file-parsing | 15 | 8 | 80 | 1000 | 4713 |
| yjs-map-conflict-detection | 15 | 3 | 77 | 999 | 1338 |
| yaegi-go-embed-directives | 15 | 6 | 73 | 1000 | 3956 |
| fastapi-deprecation-response-headers | 20 | 3 | 70 | 999 | 46933 |
| fastapi-implicit-head-options | 20 | 3 | 70 | 999 | 46933 |
| obsidian-linter-auto-table-of-contents | 10 | 4 | 70 | 994 | 2339 |
| obsidian-linter-link-format-conversion | 10 | 4 | 70 | 994 | 2339 |
| obsidian-linter-scoped-ignore-markers | 10 | 4 | 70 | 994 | 2339 |
| returns-validated-error-accumulation | 19 | 1 | 70 | 993 | 6845 |
| vitest-duration-sharding | 7 | 5 | 69 | 999 | 4917 |
| testem-bail-on-test-failure | 14 | 3 | 60 | 996 | 3506 |
| testem-per-launcher-reports | 14 | 3 | 60 | 996 | 3506 |
| aiomonitor-task-snapshots-diff | 18 | 1 | 57 | 1000 | 1617 |
| clack-async-autocomplete-options | 27 | 6 | 52 | 999 | 3048 |
| awilix-async-container-initialization | 20 | 5 | 50 | 1000 | 981 |
| kea-atomic-signal-selectors | 19 | 4 | 38 | 997 | 1239 |
| boa-hierarchical-evaluation-cancellation | 4 | 3 | 36 | 996 | 2275 |
| wasmi-trap-coredumps | 5 | 2 | 28 | 999 | 2647 |
| quill-shared-toolbar-focus | 4 | 2 | 27 | 998 | 1251 |
| abs-module-cache-flags | 5 | 1 | 21 | 996 | 1296 |
| abs-stepped-slices | 5 | 1 | 21 | 996 | 1296 |
| arktype-json-schema-refs-dependencies | 6 | 4 | 21 | 995 | 2529 |
| httpx-deterministic-cookie-store | 6 | 2 | 18 | 1000 | 1337 |
| httpx-multipart-response-parsing | 6 | 2 | 18 | 1000 | 1337 |
| httpx-streaming-json-iteration | 6 | 2 | 18 | 1000 | 1337 |
| katex-multicolumn-array-spans | 3 | 2 | 13 | 998 | 1362 |
| kombu-single-active-consumer-priority | 9 | 3 | 13 | 1000 | 2069 |
| kombu-virtual-queue-dead-lettering | 9 | 3 | 13 | 1000 | 2069 |
| psd-tools-blend-range-api | 3 | 1 | 9 | 994 | 64993 |
| skrub-duration-encoding | 8 | 2 | 8 | 995 | 3050 |
| cattrs-partial-structuring-recovery | 6 | 1 | 7 | 999 | 1137 |
| claude-code-by-agents-recursive-delegation | 5 | 1 | 4 | 1000 | 1094 |
| python-statemachine-state-data-scoping | 11 | 2 | 4 | 997 | 9549 |
| adaptix-name-mapping-aliases | 1 | 0 | 0 | 995 | 1960 |
| eicrud-keyset-pagination-cursor | — | — | — | — | ERROR: no dictionary generated |
| igel-persist-feature-schema | 8 | 0 | 0 | 998 | 1588 |
| ipython-session-bundle-replay | 3 | 0 | 0 | 999 | 1165 |
| kcp-go-multiplexed-kcp-streams | 6 | 0 | 0 | 1000 | 948 |
| koota-composite-trait-aspects | 4 | 0 | 0 | 999 | 1444 |
| koota-deferred-mutation-buffer | 4 | 0 | 0 | 999 | 1199 |
| koota-entity-snapshot-rollback | — | — | — | — | ERROR: no dictionary generated |
| koota-pair-relation-tracking | 4 | 0 | 0 | 999 | 1444 |
| koota-query-predicates | 4 | 0 | 0 | 999 | 1444 |
| langchain-request-coalescing | — | — | — | — | ERROR: no dictionary generated |
| mashumaro-flattened-dataclass-fields | 26 | 0 | 0 | 995 | 2945 |
| sqlite-utils-safe-import-checkpoints | 26 | 0 | 0 | 993 | 2301 |
| tomlkit-toml-table-converters | 12 | 0 | 0 | 999 | 1071 |
