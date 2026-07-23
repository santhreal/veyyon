# Mnemopi first-wave contract

This document freezes the public boundary of mnemopi's first-wave pure math
for the Rust port program. The JSON-level boundary lives in
`packages/mnemopi/src/core/conformance-boundary.ts`; the recorded corpus is
`packages/mnemopi/test/conformance/vectors/`. No function here may be ported
before this contract, and no TS implementation may be removed before the full
port checklist in `conformance-format.md` is green.

Boundary rule of record: every input and output crosses as plain JSON. Typed
arrays cross as number arrays; sets cross as sorted string arrays. Non-finite
NUMBERS cannot ride in a vector file's input (JSON has no encoding for them),
so non-finite input handling is locked by TS unit and property tests and
restated here as prose invariants a port must honor.

## mnemopi/vector-math

### cosineSimilarity(a: number[], b: number[]) -> number

- Iterates to the LONGER length; a missing entry reads as 0, so trailing
  zeros and absence are equivalent (recorded: "padding zeros are equivalent
  to absence").
- A non-finite entry (NaN, +-Infinity) reads as 0.
- Returns 0 when either accumulated squared norm is exactly 0 (covers empty
  inputs, zero vectors, and norms that UNDERFLOW to 0, e.g. 1e-170 entries).
- Norms that OVERFLOW to Infinity propagate: the recorded expectation for
  1e200 entries is NaN (Infinity/Infinity). This is frozen behavior, not an
  accident a port may "fix".
- Uses only IEEE-exact operations (+, *, /, sqrt): a port must match
  bit-for-bit. Operation order is dot and both norms accumulated in one
  forward pass, then `dot / (sqrt(normA) * sqrt(normB))`.

### encodeEmbeddingJson(embedding: number[]) -> string

- Exactly `JSON.stringify(embedding)`: no spaces, shortest round-trip float
  formatting (ECMAScript number-to-string). A port must reproduce the same
  bytes; this string is a persisted wire format (`embedding_json` column).

### decodeEmbeddingJson(raw: unknown) -> number[] | null

- Strict validator, never throws. Returns null for: non-string input, empty
  string, malformed JSON, non-array JSON, EMPTY array, any element that is
  not a number or not finite (`[null]`, `["2"]`, `[true]`, `[[1]]`,
  `[1e999]`).
- JSON whitespace tolerance follows JSON.parse (leading/trailing whitespace
  accepted). `-0` and subnormals are finite and accepted.
- Round-trip invariant: `decodeEmbeddingJson(encodeEmbeddingJson(v))` equals
  `v` for every finite non-empty v.

## mnemopi/binary-vectors

Bit order is MSB-first within each byte: dimension i maps to byte `i >> 3`,
bit `7 - (i & 7)`.

### quantizeInt8AsArray(embedding: number[]) -> number[] (int8 values)

- Clamps each entry to [-1, 1], non-finite reads as 0, then scales by 127
  with round-half-up MAGNITUDE symmetry: `v >= 0 ? round(v*127) :
  -round(-v*127)`, so 0.5 -> 64 and -0.5 -> -64 (NOT JS Math.round of the
  negative, which would give -63).
- Output length equals input length; values are in [-127, 127].

### binarizeAsArray(embedding: number[]) -> number[] (byte values)

- Sets the bit for every STRICTLY POSITIVE entry (0 and negatives clear;
  non-finite reads as 0 and clears).
- Dimension is clamped to `min(embedding.length, EMBEDDING_DIM)`;
  EMBEDDING_DIM defaults to 384 and is env-overridable, so the corpus only
  records inputs of <= 32 dims and the replay suite fails loudly when
  EMBEDDING_DIM < 32.
- Output has `ceil(dim / 8)` bytes; trailing bits of the last byte are 0.

### hammingDistanceFromArrays(a: number[], b: number[]) -> number

- Popcount of XOR over the shared prefix, PLUS the popcount of every byte in
  the longer array's tail (a missing byte reads as 0). Empty vs empty is 0.

### informationScore(distance: number, dim: number) -> number

- `1 - distance/dim`; returns 0 when `dim <= 0`. Distances past dim go
  negative (frozen; callers clamp if they need [0, 1]).
- The boundary form always takes dim explicitly; the TS convenience default
  (EMBEDDING_DIM) is not part of the port surface.

## mnemopi/decay

### weibullDecayFactor12(ageHours: number, memoryType?: string) -> number

- `ageHours <= 0` returns exactly 1.
- A known memoryType uses its `WEIBULL_PARAMS` entry:
  `exp(-((ageHours/eta) ** k))`. An unknown type falls back to
  `exp(-ageHours/168)` (DEFAULT_HALFLIFE_HOURS).
- The WEIBULL_PARAMS table (21 types, k/eta pairs in
  `packages/mnemopi/src/core/weibull.ts`) is part of this contract; the
  corpus records 8 representative types x 7 ages.
- Float determinism: exp/pow are NOT correctly rounded across libms, so the
  boundary value is rounded to 12 significant digits
  (`Number(x.toPrecision(12))`); a port applies the same rounding before
  comparison. All other first-wave functions compare exactly.
- `weibullBoost` (timestamp parsing) is NOT in wave one; it joins when the
  datetime parser has its own contract.

## mnemopi/text-similarity

### wordSetSorted(text: string) -> string[]

- Lowercase the text (JS toLowerCase, default locale-independent mapping),
  split on the whitespace class `\s+`, drop empty tokens, dedupe, and return
  in JS default (UTF-16 code unit) sort order. Punctuation stays attached to
  its word.

### jaccardWordSimilarity(a: string, b: string) -> number

- Jaccard index of the two word sets: `|A n B| / |A u B|`; returns 0 when
  either set is empty (never NaN).

## mnemopi/mmr

### mmrRerankRecords(results, lambdaParam, topK) -> results

- Input records are `{content?: string, score?: number}`; missing score
  reads as 0, missing content as "".
- topK is truncated toward zero and floored at 0; `topK <= 0` returns [].
- Results are first sorted by score descending with a STABLE sort (ties keep
  input order); the top item seeds the selection.
- Greedy MMR: each step picks the remaining candidate maximizing
  `lambda * score - (1 - lambda) * maxSimilarityToSelected`, with similarity
  = jaccardWordSimilarity. Strict `>` comparison: the FIRST candidate at the
  best score wins.
- If selection stops early, remaining candidates fill up to topK in their
  sorted order.

## Verification stack

- Conformance corpus: `packages/mnemopi/test/conformance/vectors/` (11
  files, 168 vectors), regenerated by
  `bun scripts/record-conformance.ts mnemopi`.
- Replay + scale lock: `packages/mnemopi/test/conformance/mnemopi-conformance.test.ts`
  and `scripts/record-conformance.test.ts` (byte-identity, orphan, and count
  locks).
- Manifest twin: `docs/migration/manifest.json` (`mnemopi/*` modules), synced
  by `packages/mnemopi/test/contract-manifest.test.ts`.
- Format spec: `conformance-format.md`; the differential gate and port
  checklist there apply unchanged (`differential-conformance.ts mnemopi`).
