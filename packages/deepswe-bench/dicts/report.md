# Argot dictionary savings per DeepSWE task

Generated 2026-07-24T18:54:01.104Z by gen-dicts.ts (SDK generateDictFromRepo, default token budget).

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
| actionlint-action-pinning-lint | 25 | 19 | 1410 | 1000 | 7098 |
| goreleaser-retry-publish-auditing | 37 | 30 | 1242 | 996 | 27999 |
| go-git-worktree-merge-conflicts | 40 | 36 | 1220 | 999 | 26443 |
| sql-formatter-bigquery-pipe-formatting | 44 | 41 | 1190 | 996 | 5105 |
| arcane-drift-detection-baselines | 34 | 30 | 1063 | 1000 | 16400 |
| updo-policy-alerting | 36 | 28 | 928 | 1000 | 2769 |
| ts-pattern-match-each | 25 | 15 | 855 | 998 | 1440 |
| scriggo-method-declarations | 30 | 24 | 836 | 999 | 6643 |
| mnamer-daemon-watch-lifecycle | 9 | 4 | 817 | 1000 | 1013 |
| pebble-durability-wait-apis | 27 | 25 | 798 | 998 | 31169 |
| effect-sse-httpapi-streaming | 69 | 66 | 747 | 995 | 32457 |
| happy-dom-abort-pending-body-reads | 30 | 28 | 679 | 995 | 19731 |
| happy-dom-deterministic-intersectionobserver | 30 | 28 | 679 | 995 | 19731 |
| expr-try-catch-errors | 35 | 25 | 671 | 995 | 5602 |
| go-critic-doc-link-checker | 36 | 24 | 660 | 1000 | 6075 |
| ytt-jsonpath-query-api | 44 | 27 | 652 | 996 | 11342 |
| sqlfmt-create-table-ddl-formatting | 31 | 8 | 650 | 999 | 3111 |
| prometheus-transactional-reload-status | 20 | 19 | 646 | 1000 | 37335 |
| prometheus-typed-label-sorting | 20 | 19 | 646 | 1000 | 37335 |
| superjson-error-stack-serialization | 49 | 33 | 626 | 995 | 862 |
| geo-shapeindex-serialization | 24 | 17 | 614 | 996 | 4931 |
| true-myth-iterable-collection-combinators | 22 | 10 | 584 | 997 | 1803 |
| oxvg-structural-selector-preservation | 30 | 17 | 575 | 995 | 10407 |
| scc-bounded-memory-spilling | 18 | 14 | 547 | 996 | 5166 |
| drizzle-orm-window-function-builders | 47 | 44 | 496 | 997 | 16515 |
| etree-xml-diff-patch | 36 | 13 | 463 | 1000 | 1030 |
| onedump-dump-encryption-pipeline | 20 | 15 | 443 | 999 | 2141 |
| bandit-incremental-cache-control | 40 | 14 | 428 | 994 | 5441 |
| bandit-interprocedural-taint-checks | 40 | 14 | 428 | 994 | 5441 |
| bandit-structured-nosec-directives | 40 | 14 | 428 | 994 | 5441 |
| task-task-graph-export | 20 | 14 | 413 | 998 | 4178 |
| dateutil-rfc5545-timezone-interop | 29 | 7 | 405 | 998 | 1495 |
| query-persist-restored-query-state | 8 | 5 | 400 | 1000 | 13838 |
| termenv-preserve-ansi-resets | 25 | 16 | 367 | 994 | 1381 |
| numba-stencil-boundary-modes | 37 | 10 | 359 | 1000 | 8393 |
| pest-character-class-coalescing | 21 | 8 | 338 | 999 | 6722 |
| dasel-html-document-format | 16 | 11 | 337 | 999 | 4578 |
| awilix-async-container-initialization | 33 | 16 | 320 | 1000 | 1009 |
| go-genai-streamed-function-args | 17 | 10 | 314 | 1000 | 3729 |
| helm-array-merge-strategies | 27 | 15 | 309 | 997 | 25566 |
| helm-unified-manifest-stream | 27 | 15 | 309 | 997 | 25566 |
| meriyah-explicit-resource-declarations | 21 | 12 | 299 | 998 | 5146 |
| optique-conditional-option-dependencies | 36 | 15 | 275 | 996 | 7625 |
| kgateway-consistent-hash-policy | 15 | 6 | 239 | 1000 | 79385 |
| dynamodb-toolbox-conditional-attribute-requirements | 26 | 21 | 229 | 998 | 10240 |
| dynamodb-toolbox-lazy-recursive-schemas | 26 | 21 | 229 | 998 | 10240 |
| sqlite-utils-safe-import-checkpoints | 30 | 3 | 215 | 995 | 2334 |
| narwhals-rolling-window-suite | 42 | 7 | 214 | 996 | 7574 |
| valibot-recursive-schema-composition | 22 | 19 | 190 | 997 | 33368 |
| obsidian-linter-auto-table-of-contents | 9 | 5 | 185 | 996 | 2132 |
| obsidian-linter-link-format-conversion | 9 | 5 | 185 | 996 | 2132 |
| obsidian-linter-scoped-ignore-markers | 9 | 5 | 185 | 996 | 2132 |
| kea-atomic-signal-selectors | 30 | 7 | 177 | 1000 | 1321 |
| kysely-window-grouping-helpers | 13 | 8 | 164 | 1000 | 7599 |
| vitest-duration-sharding | 16 | 11 | 163 | 994 | 7404 |
| yaegi-go-embed-directives | 12 | 6 | 156 | 1000 | 3568 |
| participle-grammar-conflict-analysis | 10 | 6 | 154 | 995 | 3399 |
| fd-deterministic-multi-key-sorting | 19 | 7 | 148 | 998 | 1485 |
| tengo-callable-instance-isolation | 28 | 6 | 133 | 996 | 2244 |
| tengo-destructuring-bindings | 28 | 6 | 133 | 996 | 2244 |
| pwntools-tube-multiplexing | 13 | 3 | 131 | 1000 | 20313 |
| arktype-json-schema-refs-dependencies | 11 | 10 | 118 | 1000 | 3332 |
| ink-grid-box-layout | 10 | 7 | 118 | 1000 | 5063 |
| ofetch-per-origin-circuit-breaker | 26 | 1 | 116 | 998 | 1302 |
| mobly-grouped-test-barriers | 34 | 3 | 115 | 999 | 4744 |
| aiomonitor-task-snapshots-diff | 21 | 3 | 113 | 995 | 1672 |
| csstree-shorthand-expansion-compression | 7 | 4 | 112 | 995 | 2039 |
| textual-kitty-key-phases | 27 | 5 | 107 | 996 | 16537 |
| textual-richlog-follow-state | 27 | 5 | 107 | 996 | 16556 |
| anko-default-function-arguments | 30 | 6 | 103 | 1000 | 1858 |
| anko-typed-variable-bindings | 30 | 6 | 103 | 1000 | 1858 |
| vulture-persistent-analysis-cache | 28 | 2 | 90 | 999 | 1096 |
| wazero-multi-module-snapshots | 4 | 3 | 85 | 998 | 7074 |
| yjs-map-conflict-detection | 15 | 4 | 80 | 998 | 1262 |
| clack-async-autocomplete-options | 34 | 8 | 72 | 998 | 3402 |
| returns-validated-error-accumulation | 26 | 2 | 72 | 998 | 7757 |
| fastapi-deprecation-response-headers | 18 | 3 | 70 | 995 | 40233 |
| fastapi-implicit-head-options | 18 | 3 | 70 | 995 | 40233 |
| testem-bail-on-test-failure | 14 | 3 | 60 | 996 | 3506 |
| testem-per-launcher-reports | 14 | 3 | 60 | 996 | 3506 |
| abs-module-cache-flags | 7 | 3 | 49 | 1000 | 1368 |
| abs-stepped-slices | 7 | 3 | 49 | 1000 | 1368 |
| mashumaro-flattened-dataclass-fields | 37 | 1 | 40 | 998 | 3301 |
| cliffy-config-file-parsing | 9 | 4 | 39 | 995 | 3235 |
| boa-hierarchical-evaluation-cancellation | 4 | 3 | 36 | 996 | 2275 |
| koota-deferred-mutation-buffer | 8 | 4 | 34 | 1000 | 1382 |
| wasmi-trap-coredumps | 5 | 2 | 28 | 999 | 2647 |
| quill-shared-toolbar-focus | 4 | 2 | 27 | 998 | 1251 |
| koota-composite-trait-aspects | 7 | 2 | 22 | 999 | 1690 |
| koota-pair-relation-tracking | 7 | 2 | 22 | 999 | 1690 |
| koota-query-predicates | 7 | 2 | 22 | 999 | 1690 |
| kcp-go-multiplexed-kcp-streams | 7 | 1 | 21 | 999 | 996 |
| httpx-deterministic-cookie-store | 6 | 2 | 18 | 1000 | 1337 |
| httpx-multipart-response-parsing | 6 | 2 | 18 | 1000 | 1337 |
| httpx-streaming-json-iteration | 6 | 2 | 18 | 1000 | 1337 |
| kombu-single-active-consumer-priority | 10 | 5 | 17 | 1000 | 2203 |
| kombu-virtual-queue-dead-lettering | 10 | 5 | 17 | 1000 | 2203 |
| katex-multicolumn-array-spans | 3 | 2 | 13 | 998 | 1362 |
| psd-tools-blend-range-api | 3 | 1 | 9 | 994 | 64993 |
| skrub-duration-encoding | 8 | 2 | 8 | 995 | 3050 |
| claude-code-by-agents-recursive-delegation | 5 | 1 | 4 | 1000 | 1094 |
| python-statemachine-state-data-scoping | 11 | 2 | 4 | 997 | 9549 |
| igel-persist-feature-schema | 6 | 1 | 3 | 999 | 977 |
| tomlkit-toml-table-converters | 13 | 1 | 1 | 999 | 1078 |
| adaptix-name-mapping-aliases | 1 | 0 | 0 | 995 | 1960 |
| cattrs-partial-structuring-recovery | 7 | 0 | 0 | 999 | 1239 |
| eicrud-keyset-pagination-cursor | — | — | — | — | ERROR: no dictionary generated |
| ipython-session-bundle-replay | 3 | 0 | 0 | 999 | 1165 |
| koota-entity-snapshot-rollback | — | — | — | — | ERROR: no dictionary generated |
| langchain-request-coalescing | — | — | — | — | ERROR: no dictionary generated |
