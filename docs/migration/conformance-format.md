# Conformance vector format

This document specifies the language-neutral fixture format the conformance
harness replays. Behavior is recorded once as JSON vector files and replayed
against any implementation of the same module: the TypeScript oracle today, a
Rust port tomorrow, both consuming the identical files. The TS runner lives in
`packages/utils/src/conformance.ts`; a port implements this document, not that
file.

## File layout

Vectors live next to the module's tests, one directory per corpus:

```
packages/<pkg>/test/conformance/vectors/*.json
```

Every `*.json` file in the directory is part of the corpus. The runner loads
files in byte-sorted name order. A directory with no `*.json` files is an
error: an empty corpus must never pass.

## Vector file schema (version 1)

Each file targets exactly one exported function of the module under test:

```json
{
 "schemaVersion": 1,
 "module": "hashline/tokenizer",
 "function": "splitHashlineLines",
 "vectors": [
  {"name": "two LF lines", "input": ["a\nb"], "expected": ["a", "b"]},
  {"name": "zero rejected", "input": ["0", 2], "expectedError": "expected a line number"}
 ]
}
```

Fields:

- `schemaVersion` (number, required): must equal `1`. A runner that sees any
  other value refuses the file. Bump the version only with a migration note
  added to this document.
- `module` (string, required): the module the corpus describes, for humans and
  reports. It does not affect dispatch.
- `function` (string, required): the exported function every vector in this
  file calls. A function the implementation does not export is a fatal error
  (the corpus and the boundary drifted), never a skip.
- `vectors` (array, required, non-empty): the recorded calls.

Each vector:

- `name` (string, required): unique within its file. Names the behavior, not
  the input bytes. Duplicate names are a fatal error.
- `input` (array, required): positional arguments, JSON-encodable.
- `expected` (any): the exact return value. Compared canonically (below).
- `expectedError` (string): a substring the thrown error's message must
  contain. Exactly one of `expected` / `expectedError` is required; both or
  neither is a fatal error.
- `meta` (object, optional): provenance and notes. Never affects the verdict.

## Canonical comparison

Two values are conformance-equal exactly when their canonical serializations
are byte-equal. Canonicalization:

1. Objects serialize with keys in ascending code-unit sort order, recursively.
2. Arrays keep their order (order is behavior).
3. `-0` folds to `0`.
4. Non-finite numbers, which plain JSON cannot hold, encode as tagged strings
   prefixed with a NUL character (U+0000), which cannot collide with real
   recorded text: `"\u0000conformance:nan"`, `"\u0000conformance:+inf"`,
   `"\u0000conformance:-inf"`. An implementation returning `undefined` (a
   TS-only value) encodes as `"\u0000conformance:undefined"`.
5. Everything else serializes as standard JSON.

A Rust runner must reproduce this serialization bit-for-bit (serde_json with
sorted maps plus the four rules above) before comparing.

## Failure policy

Structural corpus defects are fatal errors, never skips: invalid JSON, an
unknown `schemaVersion`, a missing `module`/`function`, an empty `vectors`
array, a nameless or duplicate-named vector, a non-array `input`, a missing or
doubled expectation, an unreadable or empty vector directory, and a `function`
the implementation does not export. Behavioral divergences are collected, not
short-circuited: one run reports every diverging vector with the canonical
`expected` and `got` strings.

## Reference corpus

The first fully wired module is `hashline` (tokenizer + normalize):
`packages/hashline/test/conformance/vectors/`, replayed by
`packages/hashline/test/conformance/hashline-conformance.test.ts`, which also
pins the corpus file and vector counts so a file dropped from disk cannot pass
silently. Use it as the template when wiring the next module.

## Recording vectors

Vector files are generated, not hand-written. `scripts/record-conformance.ts`
runs the current TypeScript implementation as the oracle over a deterministic,
named input enumeration and rewrites the module's vector files:

```
bun scripts/record-conformance.ts hashline          # rewrite the corpus
bun scripts/record-conformance.ts hashline --check  # fail if disk differs
```

The enumeration lives in the script (curated cases plus generated families:
line-ending matrices, decision tables, unicode and scale cases, reject lists)
and uses no randomness or wall clock, so back-to-back runs are byte-identical.
Thrown errors are recorded as `expectedError` with the full message, which the
replayer matches as a substring.

`scripts/record-conformance.test.ts` re-renders every recorded module in
memory and requires the checked-in files to match byte for byte, with no
orphan files and no shrunk corpus. To change behavior, change the oracle,
regenerate, and review the vector diff in the same change; a hand-edited
vector fails that lock.

## Rust runner sketch

A port's runner walks the same directory, deserializes each file into the
schema above (rejecting unknown versions and structural defects with the same
failure policy), calls its own implementation of `function` with the decoded
`input` array, canonicalizes with the rules above, and compares byte-equal.
Error vectors assert the returned error's display string contains
`expectedError`. The corpus files themselves are the contract; they are
checked in and shared verbatim between the implementations.

## Differential gate and port protocol

`scripts/differential-conformance.ts <module> -- <command> [args...]` is the
cross-language gate: it spawns the port command once with the vector
directory appended as the last argument, and the port prints one NDJSON line
per vector to stdout:

```
{"file":"tokenizer-parse-lid.json","name":"plain number","output":{"line":5}}
{"file":"tokenizer-parse-lid.json","name":"empty anchor is rejected","error":"line 4: expected a line number ..."}
```

Order does not matter. Values are compared through the canonicalization above;
errors match by `expectedError` substring. A non-finite numeric output has no
JSON form: the port MUST emit the canonical NUL-tag string
(`"\u0000conformance:nan"` etc.) instead, exactly as recorded vector files
store it; printing a raw NaN through a JSON serializer yields `null` and
fails the comparison. A missing, extra, duplicate, or
unparseable result is a failure, so a port cannot pass by skipping vectors.
`scripts/conformance-port-oracle.ts` is the protocol's reference
implementation (the TS boundary speaking the protocol), and
`scripts/differential-conformance.test.ts` proves the gate passes a faithful
port and fails a sabotaged one.

## Port checklist

A module may only be ported, and its TS implementation only removed, in this
order. Each step gates the next:

1. Contract exists (`<module>-contract.md` + `manifest.json` entry, with the
   manifest sync test green).
2. Corpus green on TS (`record-conformance.ts <module> --check` and the
   package conformance suite pass).
3. The port passes the same corpus through its own runner.
4. The differential gate is green:
   `bun scripts/differential-conformance.ts <module> -- <port command>`.
5. Perf meets-or-beats the TS baseline (`bench/` guard for the module) on the
   reference machine.
6. Only then may the TS implementation be removed, as its own reviewed
   change, and the differential gate rewired to compare the port against the
   frozen corpus alone.
