import { describe, expect, it } from "bun:test";
import {
	asRecord,
	errorMessage,
	estimateTextTokens,
	getNonBlankStringProperty,
	getStringProperty,
	isRecord,
} from "@veyyon/pi-utils";
import { Glob } from "bun";

describe("isRecord", () => {
	it("accepts plain objects and rejects arrays, null, and primitives", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
		expect(isRecord(42)).toBe(false);
		expect(isRecord(undefined)).toBe(false);
	});
});

describe("asRecord", () => {
	it("returns the record itself or null", () => {
		const value = { a: 1 };
		expect(asRecord(value)).toBe(value);
		expect(asRecord([1])).toBeNull();
		expect(asRecord("x")).toBeNull();
	});
});

describe("getStringProperty", () => {
	it("reads own string properties only", () => {
		expect(getStringProperty({ message: "hi" }, "message")).toBe("hi");
		expect(getStringProperty({ message: 5 }, "message")).toBeUndefined();
		expect(getStringProperty({}, "message")).toBeUndefined();
		// Prototype-chain values are not own properties.
		expect(getStringProperty({}, "constructor")).toBeUndefined();
	});

	it("returns blank strings verbatim (contrast with getNonBlankStringProperty)", () => {
		expect(getStringProperty({ message: "" }, "message")).toBe("");
		expect(getStringProperty({ message: "  " }, "message")).toBe("  ");
	});
});

describe("getNonBlankStringProperty", () => {
	it("returns non-blank strings and treats blank/whitespace strings as absent", () => {
		expect(getNonBlankStringProperty({ message: "real" }, "message")).toBe("real");
		expect(getNonBlankStringProperty({ message: "" }, "message")).toBeUndefined();
		expect(getNonBlankStringProperty({ message: "   " }, "message")).toBeUndefined();
		expect(getNonBlankStringProperty({ message: 7 }, "message")).toBeUndefined();
		expect(getNonBlankStringProperty({}, "message")).toBeUndefined();
	});
});

// ONE-PLACE lock: isRecord was hand-rolled 12x across coding-agent/src with three
// divergent variants (two accepted arrays). It now lives only in type-guards.ts —
// a second definition must re-import, not re-declare, or copies drift.
// Allowed exception: launch/protocol.ts is a deliberately dependency-free
// cross-process protocol module (zero imports) and keeps a self-contained guard.
describe("isRecord/asRecord one-place lock", () => {
	async function findDefinitions(pattern: RegExp): Promise<string[]> {
		const root = `${import.meta.dir}/../../..`;
		const definitions: string[] = [];
		for (const pkg of [
			"utils/src",
			"ai/src",
			"agent/src",
			"coding-agent/src",
			"tui/src",
			"mnemopi/src",
			"stats/src",
			"catalog/src",
			"tool-render/src",
			"collab-web/src",
			"wire/src",
			"metaharness/src",
		]) {
			const glob = new Glob("**/*.ts");
			for await (const rel of glob.scan({ cwd: `${root}/packages/${pkg}` })) {
				// Vendored snapshots are read-only copies of upstream, not duplicate owners.
				if (rel.startsWith("vendor/") || rel.includes("/vendor/")) continue;
				const src = await Bun.file(`${root}/packages/${pkg}/${rel}`).text();
				if (pattern.test(src)) definitions.push(`${pkg}/${rel}`);
			}
		}
		return definitions.sort();
	}

	it("isRecord is defined in exactly one shared source file (plus the dependency-free protocol module)", async () => {
		expect(await findDefinitions(/function\s+isRecord\b/)).toEqual([
			"coding-agent/src/launch/protocol.ts",
			"utils/src/type-guards.ts",
		]);
	});

	// asRecord was hand-rolled 6x (three copies accepted arrays; dialect
	// coercion's `{}`-returning variant is a different contract and now lives
	// as asRecordOrEmpty). One definition; everything else imports.
	it("asRecord is defined only in type-guards.ts", async () => {
		expect(await findDefinitions(/function\s+asRecord\b/)).toEqual(["utils/src/type-guards.ts"]);
	});

	// Text-token estimation was hand-rolled 4x with FOUR different formulas
	// (bytes-ceil, max(1,floor/4), floor/4, ceil/4). One byte-based owner now;
	// message-level estimateTokens(AgentMessage) in compaction is a different
	// function and keeps its name.
	it("estimateTextTokens is defined only in tokens.ts, and no text-level estimateTokens returns", async () => {
		expect(await findDefinitions(/function\s+estimateTextTokens\b/)).toEqual(["utils/src/tokens.ts"]);
		expect(await findDefinitions(/function\s+estimateTokens\(text/)).toEqual([]);
	});

	// URL trailing-slash strip was hand-rolled in 6 normalizeBaseUrl policies
	// (two only stripped ONE slash) plus a bespoke loop in mnemopi local-llm.
	it("stripTrailingSlash(es) is defined only in url.ts", async () => {
		expect(await findDefinitions(/function\s+stripTrailingSlashe?s?\b/)).toEqual(["utils/src/url.ts"]);
	});

	// errorMessage was hand-rolled 6x in coding-agent alone (all byte-identical
	// `instanceof Error ? .message : String(...)` copies).
	it("errorMessage is defined only in type-guards.ts", async () => {
		expect(await findDefinitions(/function\s+errorMessage\b/)).toEqual(["utils/src/type-guards.ts"]);
	});

	it("errorMessage never returns an empty string", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage(new Error(""))).toBe("Error");
		expect(errorMessage("")).toBe("Unknown error");
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage(42)).toBe("42");
	});

	// mapStopReason was defined 5x with five DIFFERENT wire contracts (OpenAI
	// finish_reason, Anthropic stop_reason, Gemini FinishReason, Bedrock Converse,
	// and telemetry's reverse StopReason→OTel map). Each is now provider-scoped
	// (mapOpenAiFinishReason, mapAnthropicStopReason, mapGoogleFinishReason,
	// mapBedrockStopReason, mapStopReasonToOtel) so the shared name can't imply
	// a shared contract.
	it("no bare mapStopReason definition exists", async () => {
		expect(await findDefinitions(/function\s+mapStopReason\b/)).toEqual([]);
	});

	// splitLines was hand-rolled 4x with three divergent contracts. The trim+drop-
	// blanks variant (git/jj CLI output) now lives in lines.ts as
	// trimmedNonEmptyLines; the LaTeX row splitter and the keep-interior-empties
	// variant were renamed (splitLatexRows, splitLinesDropTrailingEmpty) so the
	// shared name can't mislead. (The read-only vendor snapshot keeps its copy but
	// vendored code is excluded from the scan.)
	it("splitLines has no editable definition", async () => {
		expect(await findDefinitions(/function\s+splitLines\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+trimmedNonEmptyLines\b/)).toEqual(["utils/src/lines.ts"]);
	});

	// ai's schema meta-validator hand-rolled "isPlainObject" with isRecord
	// semantics (no prototype check) — now imports isRecord. utils/index.ts keeps
	// isPlainJsonContainer, a different contract (accepts arrays; internal to
	// structuredCloneJSON), renamed so the shared name can't imply a guard.
	it("no isPlainObject definition exists anywhere", async () => {
		expect(await findDefinitions(/function\s+isPlainObject\b/)).toEqual([]);
	});

	// ai/dialect/rendering.ts duplicated the XML escapers (naive replaceAll
	// twins of the allocation-conscious utils owners) and shadowed utils'
	// stringifyJson with a null-defaulting wrapper — the escapers now import
	// the owners; the wrapper is stringifyJsonOrNull (a distinct contract).
	it("escapeXmlText/escapeXmlAttribute/stringifyJson each have one owner", async () => {
		expect(await findDefinitions(/function\s+escapeXmlText\b/)).toEqual(["utils/src/sanitize-text.ts"]);
		expect(await findDefinitions(/function\s+escapeXmlAttr(ibute)?\b/)).toEqual(["utils/src/sanitize-text.ts"]);
		expect(await findDefinitions(/function\s+stringifyJson\b/)).toEqual(["utils/src/json.ts"]);
		expect(await findDefinitions(/function\s+stringifyJsonOrNull\b/)).toEqual(["ai/src/dialect/rendering.ts"]);
	});

	// Provider-plumbing sweep: six provider-policy normalizeBaseUrl locals were
	// renamed to provider-scoped names (the shared primitive is url.ts's
	// stripTrailingSlashes); toHex twins unified on binary.ts bytesToHex;
	// normalizeDevinSessionToken deduped into ai/providers/devin.ts (catalog
	// imports it); divergent contracts renamed (isRetryableUsageStatus excludes
	// 429 by design, parseBindPort throws on bad input).
	it("provider plumbing names each have one owner", async () => {
		expect(await findDefinitions(/function\s+normalizeBaseUrl\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+toHex\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+bytesToHex\b/)).toEqual(["utils/src/binary.ts"]);
		expect(await findDefinitions(/function\s+normalizeDevinSessionToken\b/)).toEqual(["ai/src/providers/devin.ts"]);
		expect(await findDefinitions(/function\s+isRetryableStatus\b/)).toEqual(["utils/src/fetch-retry.ts"]);
		expect(await findDefinitions(/function\s+getRecord\b/)).toEqual(["coding-agent/src/web/scrapers/w3c.ts"]);
	});

	// Filesystem/process plumbing had per-package twins; each now has one owner.
	// isProcessAlive unified on the ESRCH-aware body (EPERM = exists = alive) —
	// file-lock's old any-error-means-dead variant could misjudge locks held by
	// processes we cannot signal. removeWithRetries unified on utils/temp
	// (documented 50ms Windows retry delay). looksLikeSqlite/SQLITE_MAGIC own the
	// header sniff for sqlite-reader and mnemopi dr/recovery.
	it("fs/process plumbing names each have one owner", async () => {
		expect(await findDefinitions(/function\s+isProcessAlive\b/)).toEqual(["utils/src/process.ts"]);
		expect(await findDefinitions(/function\s+removeWithRetries\b/)).toEqual(["utils/src/temp.ts"]);
		expect(await findDefinitions(/function\s+looksLikeSqlite\b/)).toEqual(["utils/src/binary.ts"]);
		expect(await findDefinitions(/function\s+isSqliteFile\b/)).toEqual(["coding-agent/src/tools/sqlite-reader.ts"]);
		expect(await findDefinitions(/function\s+countNonEmptyLines\b/)).toEqual(["utils/src/lines.ts"]);
	});

	// Abort-error twins: the duck-typed name check is now utils isAbortOrTimeoutError
	// (cross-realm safe superset of both old bodies). The createAbortError factories
	// diverged (kernel-base builds a plain Error with a chosen name for eval kernels;
	// anthropic-client throws AIError.AbortError) — the latter was renamed
	// createRequestAbortError. jaccard twins were identical math; utils owns it.
	it("abort/similarity helpers each have one owner", async () => {
		expect(await findDefinitions(/function\s+isAbortError\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+isAbortOrTimeoutError\b/)).toEqual(["utils/src/abortable.ts"]);
		expect(await findDefinitions(/function\s+createAbortError\b/)).toEqual(["coding-agent/src/eval/kernel-base.ts"]);
		expect(await findDefinitions(/function\s+jaccard\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+jaccardSimilarity\b/)).toEqual(["utils/src/similarity.ts"]);
		expect(await findDefinitions(/function\s+wordJaccardSimilarity\b/)).toEqual(["mnemopi/src/core/mmr.ts"]);
	});

	// Record-field coercers and id factories: divergent same-name twins renamed to
	// their contracts (asStringOrEmpty/asStringOrNull/asNumberOr in beam/recall,
	// asOptionalString in openai-responses-server, finiteNumberOrNull/-OrZero,
	// generateTimedId vs generateUniqueEntryId). zai's asString twin was identical
	// to scrapers/utils' owner and now imports it. asStrict became utils
	// toStrictUint8Array; collab-web keeps a documented dependency-free copy
	// (browser bundle, outside these scan roots).
	it("coercer and id-factory names each have one owner", async () => {
		expect(await findDefinitions(/function\s+asString\b/)).toEqual(["coding-agent/src/web/scrapers/utils.ts"]);
		expect(await findDefinitions(/function\s+asNumber\b/)).toEqual(["coding-agent/src/web/scrapers/utils.ts"]);
		// codec.ts keeps a documented copy of toStrictUint8Array: the owner
		// module (utils/src/binary.ts) imports node:buffer, unusable in the
		// collab-web browser bundle.
		expect(await findDefinitions(/function\s+asStrict\b/)).toEqual(["collab-web/src/lib/codec.ts"]);
		expect(await findDefinitions(/function\s+toStrictUint8Array\b/)).toEqual(["utils/src/binary.ts"]);
		expect(await findDefinitions(/function\s+toFiniteNumber\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+generateId\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+generateTimedId\b/)).toEqual(["mnemopi/src/util/ids.ts"]);
	});

	// Timer/stream plumbing: abortableSleep (exa + ai mock twins) and readPipe
	// (runtime-install + worker-runtime twins) each unified onto one utils owner;
	// extraction/client's plain sleep became Bun.sleep. The two mnemopi `sleep`
	// definitions are the memory-consolidation domain feature (core/memory.ts is
	// the bank facade delegating to core/beam/consolidate.ts), not timer twins.
	// abortReason had three divergent domain fallbacks, renamed to their contracts
	// (aiAbortReason, lspAbortReason, domAbortReason); isHexDigit/isWhitespace
	// keep JSON-spec owners in json-parse.ts, divergent variants renamed
	// (isHexDigitChar, isAsciiWhitespace).
	it("timer/stream/abort plumbing names each have one owner", async () => {
		expect(await findDefinitions(/function\s+abortableSleep\b/)).toEqual(["utils/src/async.ts"]);
		expect(await findDefinitions(/function\s+readPipe\b/)).toEqual(["utils/src/stream.ts"]);
		expect(await findDefinitions(/function\s+sleep\b/)).toEqual([
			"mnemopi/src/core/beam/consolidate.ts",
			"mnemopi/src/core/memory.ts",
		]);
		expect(await findDefinitions(/function\s+abortReason\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+isHexDigit\b/)).toEqual(["utils/src/json-parse.ts"]);
		expect(await findDefinitions(/function\s+isWhitespace\b/)).toEqual(["utils/src/json-parse.ts"]);
	});

	// SQLite/table plumbing and misc divergent locals: tableExists unified on the
	// beam/helpers owner (recall's beam-flavored twin and shmr's type='table'-only
	// twin deleted — virtual tables report type='table' in sqlite_master, so the
	// bodies were equivalent). Divergent locals renamed to their contracts:
	// gemma matchDelimSkippingStrings, mcp serverCacheKey, logout nonEmptyTrimmed,
	// cursor parseEpochMs (epoch-ms number vs weibull's Date|null parseTimestamp);
	// gc-cli's view-matching variant renamed tableOrViewExists.
	it("sqlite/misc plumbing names each have one owner", async () => {
		expect(await findDefinitions(/function\s+tableExists\b/)).toEqual(["mnemopi/src/core/beam/helpers.ts"]);
		expect(await findDefinitions(/function\s+matchDelim\b/)).toEqual(["tui/src/latex-block.ts"]);
		expect(await findDefinitions(/function\s+cacheKey\b/)).toEqual(["utils/src/which.ts"]);
		expect(await findDefinitions(/function\s+nonEmpty\b/)).toEqual(["ai/src/registry/oauth/anthropic.ts"]);
		expect(await findDefinitions(/function\s+parseTimestamp\b/)).toEqual(["mnemopi/src/core/weibull.ts"]);
	});

	// levenshteinDistance was implemented twice (mnemopi codepoint-based,
	// edit/replace UTF-16 two-row); one UTF-16 owner now lives in levenshtein.ts
	// (identical results for all BMP inputs both consumers see). The similarity
	// twins had different contracts: entities' case-insensitive prefix-boosted
	// metric is now entitySimilarity; replace.ts keeps the raw normalized ratio.
	it("levenshteinDistance and the similarity metrics each have one owner", async () => {
		expect(await findDefinitions(/function\s+levenshteinDistance\b/)).toEqual(["utils/src/levenshtein.ts"]);
		expect(await findDefinitions(/function\s+similarity\b/)).toEqual(["coding-agent/src/edit/modes/replace.ts"]);
		expect(await findDefinitions(/function\s+entitySimilarity\b/)).toEqual(["mnemopi/src/core/entities.ts"]);
	});

	// Format family: utils/src/format.ts owns the fixed-format display helpers.
	// Divergent variants were renamed to their real contracts (formatDurationWords,
	// formatTrackDuration, formatTrackDurationMs, formatNumberGrouped,
	// formatBytesIEC); identical twins import the owner. The stats client
	// dashboard re-exports the utils owners (formatCost/formatPercent/formatBytes
	// grew the client's digits/$0 superset — DEDUP-FMT-CLIENT). Remaining
	// exception is documented per-lane: status-line/segments.ts
	// normalizePremiumRequests (UI-lane file).
	it("format helpers each have one owner (plus documented lane exceptions)", async () => {
		expect(await findDefinitions(/function\s+formatCost\b/)).toEqual(["utils/src/format.ts"]);
		expect(await findDefinitions(/function\s+normalizePremiumRequests\b/)).toEqual([
			"coding-agent/src/modes/components/status-line/segments.ts",
			"utils/src/format.ts",
		]);
		expect(await findDefinitions(/function\s+formatCount\b/)).toEqual(["utils/src/format.ts"]);
		expect(await findDefinitions(/function\s+formatBytes\b/)).toEqual(["utils/src/format.ts"]);
		expect(await findDefinitions(/function\s+formatPercent\b/)).toEqual(["utils/src/format.ts"]);
		// tool-render's divergent copy (overflowed maxLen by one) deduped onto the owner.
		expect(await findDefinitions(/function\s+truncate\b/)).toEqual(["utils/src/format.ts"]);
		// Browser-safe `~`-substitution owner; tool-render re-exports it and
		// collab-web wraps it to pin its elision policy. coding-agent's
		// shortenPath is the distinct homedir-aware CLI contract (node:os).
		expect(await findDefinitions(/function\s+shortenPathDisplay\b/)).toEqual(["utils/src/path-display.ts"]);
		expect(await findDefinitions(/function\s+shortenPath\b/)).toEqual([
			"coding-agent/src/tools/render-utils.ts",
			"collab-web/src/lib/format.ts",
		]);
		expect(await findDefinitions(/function\s+formatNumber\b/)).toEqual(["utils/src/format.ts"]);
		// Whitespace collapsing: named twins (tool-render normalizeWs, mnemopi
		// compactWhitespace, ask.ts flattenDescription, tui sanitizeSingleLine)
		// deduped onto the utils/src/lines.ts collapseWhitespace owner (locked
		// below with the misc pairs); tool-render keeps an alias re-export and
		// tui sanitizeSingleLine delegates.
		expect(await findDefinitions(/function\s+normalizeWs\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+compactWhitespace\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+flattenDescription\b/)).toEqual([]);
	});

	// Cross-package misc pairs: hsvToRgb (protocol-probe twin deleted, imports
	// utils/color); ensureDir (sshfs-mount's 0700-hardened variant renamed
	// ensurePrivateDir; logger keeps the plain local); env coercers (hindsight's
	// OpenCode-semantics value-coercers renamed coerceEnv*; mnemopi/util/env owns
	// the name-based lookups); normalizePathForComparison (update-cli's
	// deliberately-lexical variant renamed normalizePathLexical).
	it("misc cross-package names each resolve to one owner", async () => {
		expect(await findDefinitions(/function\s+hsvToRgb\b/)).toEqual(["utils/src/color.ts"]);
		expect(await findDefinitions(/function\s+normalizePathForComparison\b/)).toEqual(["utils/src/dirs.ts"]);
		expect(await findDefinitions(/function\s+envBool\b/)).toEqual(["mnemopi/src/util/env.ts"]);
		expect(await findDefinitions(/function\s+envInt\b/)).toEqual(["mnemopi/src/util/env.ts"]);
		expect(await findDefinitions(/function\s+envString\b/)).toEqual(["mnemopi/src/util/env.ts"]);
		expect(await findDefinitions(/function\s+ensureDir\b/)).toEqual(["utils/src/logger.ts"]);
	});

	// The collab join-link grammar is a wire contract parsed on both sides
	// (agent collab/protocol.ts, browser collab-web lib/link.ts); the regexes
	// and the ws://-allowlist live in pi-wire so the two ends cannot drift.
	it("collab link grammar is owned by pi-wire", async () => {
		expect(await findDefinitions(/const\s+ROOM_PATH_RE\b/)).toEqual(["wire/src/index.ts"]);
		expect(await findDefinitions(/const\s+BARE_LINK_RE\b/)).toEqual(["wire/src/index.ts"]);
		expect(await findDefinitions(/const\s+B64URL_RE\b/)).toEqual(["wire/src/index.ts"]);
		expect(await findDefinitions(/function\s+isLocalHostname\b/)).toEqual(["wire/src/index.ts"]);
	});

	// Shared grammar regexes: previously hand-rolled at 5 (URL scheme), 3
	// (UUID), 4 (ISO date), and 2 (SGR escape) sites; each now has one owner.
	// The literal-pattern locks catch a re-pasted copy even under a new name.
	it("grammar regexes each have one owner", async () => {
		expect(await findDefinitions(/const\s+URL_SCHEME_RE\s*=/)).toEqual(["utils/src/regex.ts"]);
		// Anchored case-insensitive http(s) detector. The lenient `\/\/?` variant
		// (tools/path-utils), multi-scheme alternations (plugins/git-url), and
		// non-i display strips are distinct grammars. The modes/ copy is the
		// user's UI lane — pending coordination; shrink when it lands.
		expect(await findDefinitions(/const\s+HTTP_URL_RE\s*=/)).toEqual(["utils/src/regex.ts"]);
		expect(await findDefinitions(/\^https\?:\\\/\\\/\/i/)).toEqual([
			"coding-agent/src/modes/controllers/mcp-command-controller.ts",
			"utils/src/regex.ts",
		]);
		expect(await findDefinitions(/const\s+UUID_RE\s*=/)).toEqual(["utils/src/regex.ts"]);
		expect(await findDefinitions(/const\s+ISO_DATE_RE\s*=/)).toEqual(["utils/src/regex.ts"]);
		// Exact canonical-UUID literal (anchored, any-version). Version-specific
		// grammars (advisor's UUIDv7) and embedded uses (anthropic session ids)
		// are distinct predicates, not copies.
		expect(await findDefinitions(/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-/)).toEqual([
			"utils/src/regex.ts",
		]);
		expect(await findDefinitions(/\\x1b\\\[\[0-9;:\]\*m/)).toEqual(["tui/src/utils.ts"]);
		expect(await findDefinitions(/function\s+stripTaskResultEnvelope\b/)).toEqual(["utils/src/task-result.ts"]);
		// Whole-line XML tag grammar (prompt.ts parsing + agent compaction shake).
		expect(await findDefinitions(/\^<\(\[a-z_-\]\+\)/)).toEqual(["utils/src/regex.ts"]);
		// "Has a letter or digit" predicate (hindsight substantive-content, TTS speakability).
		expect(await findDefinitions(/\[\\p\{L\}\\p\{N\}\]\/u/)).toEqual(["utils/src/regex.ts"]);
		// Default metaharness job name (CLI runner + server must name jobs identically).
		expect(await findDefinitions(/function\s+defaultJobName\b/)).toEqual(["metaharness/src/launch-args.ts"]);
		// Custom-tool script extension list (all discovery providers must agree).
		expect(await findDefinitions(/\(ts\|js\|sh\|bash\|py\)/)).toEqual(["coding-agent/src/discovery/helpers.ts"]);
		// Filesystem-safe segment charset (runtime cache keys, derived file names).
		// The `+`-run variants (agent-bridge, mental-models, docs-rs) collapse runs
		// — a different output shape, not copies.
		expect(await findDefinitions(/\[\^A-Za-z0-9\._-\]\/g/)).toEqual(["utils/src/format.ts"]);
		// Run-collapsing `→"_"` twin (agent-bridge patch slugs, docs-rs cache
		// segments) lives in format.ts derived from the same charset; the raw
		// literal must never reappear. mental-models' `→"-"`+trim is distinct.
		expect(await findDefinitions(/function\s+safeFilenameSegmentCollapsed\b/)).toEqual(["utils/src/format.ts"]);
		expect(await findDefinitions(/\[\^A-Za-z0-9\._-\]\+\/g,\s*"_"/)).toEqual([]);
		// Tool-call-id unsafe charset (6 provider sites; mnemopi config's `+`-run
		// case-preserving id slug is a different operation).
		expect(await findDefinitions(/\[\^a-zA-Z0-9_-\]\/g/)).toEqual(["ai/src/utils.ts"]);
		// Kebab slugify (branch names, remote names, advisor ids, usage-limit slugs).
		// The mnemopi/state, memories, markit-cache, thinking-loop variants use
		// different separators ("_" / " ") — distinct operations, not copies.
		expect(await findDefinitions(/function\s+kebabSlug\b/)).toEqual(["utils/src/format.ts"]);
		expect(await findDefinitions(/\[\^a-z0-9\]\+\/g,\s*"-"/)).toEqual(["utils/src/format.ts"]);
		// Agent-output name sanitizer (vibe runtime + eval agent bridge feed the
		// same AgentOutputManager.allocate; strip-to-empty + cap 48). The
		// session/artifacts.ts `→"_"` variant is a distinct operation.
		expect(await findDefinitions(/function\s+sanitizeOutputName\b/)).toEqual([
			"coding-agent/src/task/output-manager.ts",
		]);
		expect(await findDefinitions(/\[\^A-Za-z0-9_-\]\+\/g,\s*""\)/)).toEqual([
			"coding-agent/src/task/output-manager.ts",
		]);
		// Strict-base64 predicate (Google thought signatures, eval image payloads).
		expect(await findDefinitions(/\[A-Za-z0-9\+\/\]\+=\{0,2\}/)).toEqual(["utils/src/regex.ts"]);
		// TTSR scope-token grammar (live engine + scan CLI must agree).
		expect(await findDefinitions(/\?<prefix>tool\)/)).toEqual(["coding-agent/src/capability/rule-scope.ts"]);
		// Non-alphanumeric-run splitter. The modes/ copy is the user's UI lane —
		// pending coordination (DEDUP-ALNUM-RE ledger row); shrink this list when it lands.
		expect(await findDefinitions(/\[\^\\p\{L\}\\p\{N\}\]\+/)).toEqual([
			"coding-agent/src/modes/components/history-search.ts",
			"utils/src/regex.ts",
		]);
	});

	// escapeRegExp was hand-rolled 4x (mnemopi/state, legacy-pi-compat,
	// magic-keyword-boundary, openai-reasoning-fallback), all escaping the same
	// metachar set — then twice more under other names (mcp-protocol escapeRegex,
	// hashline regexEscape). One owner in regex.ts; the literal lock catches
	// renamed re-pastes. hashline keeps a documented local copy because it
	// publishes standalone without a pi-utils dependency (not in the scan roots).
	it("escapeRegExp is defined only in regex.ts", async () => {
		expect(await findDefinitions(/function\s+escapeRegExp\b/)).toEqual(["utils/src/regex.ts"]);
		expect(await findDefinitions(/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]/)).toEqual(["utils/src/regex.ts"]);
	});

	// findApiKey existed 8x: five authStorage-pipeline copies were dead exports
	// (the live search path resolves keys via authStorage.resolver + withAuth).
	// Only the env-based, provider-scoped lookups remain.
	it("findApiKey exists only in the env-based lookups (exa, brave, jina)", async () => {
		expect(await findDefinitions(/function\s+findApiKey\b/)).toEqual([
			"coding-agent/src/exa/mcp-client.ts",
			"coding-agent/src/web/search/providers/brave.ts",
			"coding-agent/src/web/search/providers/jina.ts",
		]);
	});

	// Text-block joining: utils/src/text-blocks.ts joinTextBlocks owns "concatenate
	// the text blocks of a content array". Six extractText twins (cursor,
	// speech-enhancer, classifier, gh-renderer, prompt-detection, perplexity) and
	// the local-llm assistantText were deleted; copy-targets/state.ts keep thin
	// assistantText wrappers (role/shape checks) that delegate to the owner.
	// formatError is a designed polymorphic contract: the four ai provider server
	// modules each implement RouteModule.formatError (ai/src/auth-gateway/types.ts)
	// with provider-specific error JSON shapes -- interface implementations, not
	// dups. yield-queue's unrelated formatError (message-only) now imports the
	// canonical utils errorMessage. errorText (worker-runtime) is divergent:
	// stack-preferring serialization for cross-process transport.
	it("text-block joining and error formatting each have one owner", async () => {
		expect(await findDefinitions(/function\s+joinTextBlocks\b/)).toEqual(["utils/src/text-blocks.ts"]);
		expect(await findDefinitions(/function\s+extractText\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+assistantText\b/)).toEqual([
			"coding-agent/src/modes/utils/copy-targets.ts",
		]);
		expect(await findDefinitions(/function\s+assistantTextFromContent\b/)).toEqual([
			"coding-agent/src/mnemopi/state.ts",
		]);
		expect(await findDefinitions(/function\s+formatError\b/)).toEqual([
			"ai/src/providers/anthropic-messages-server.ts",
			"ai/src/providers/openai-chat-server.ts",
			"ai/src/providers/openai-responses-server.ts",
			"ai/src/providers/pi-native-server.ts",
		]);
		expect(await findDefinitions(/function\s+errorMessage\b/)).toEqual(["utils/src/type-guards.ts"]);
		expect(await findDefinitions(/function\s+errorText\b/)).toEqual([
			"coding-agent/src/subprocess/worker-runtime.ts",
		]);
	});

	// Five tokenize() defs disambiguated: the two identical quote-aware arg
	// splitters unified on slash-commands/helpers/todo.ts tokenizeQuotedArgs
	// (todo-command-controller imports it); the three divergent tokenizers were
	// renamed to their contracts (recall stop-worded word extraction, tool-index
	// accent-folding camel/acronym search normalization, gh-cache-invalidation
	// shell segment splitting into string[][]).
	it("tokenize variants each have one contract-named owner", async () => {
		expect(await findDefinitions(/function\s+tokenize\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+tokenizeQuotedArgs\b/)).toEqual([
			"coding-agent/src/slash-commands/helpers/todo.ts",
		]);
		expect(await findDefinitions(/function\s+tokenizeRecallText\b/)).toEqual(["mnemopi/src/core/beam/recall.ts"]);
		expect(await findDefinitions(/function\s+tokenizeForIndex\b/)).toEqual([
			"coding-agent/src/tool-discovery/tool-index.ts",
		]);
		expect(await findDefinitions(/function\s+tokenizeShellSegments\b/)).toEqual([
			"coding-agent/src/tools/gh-cache-invalidation.ts",
		]);
	});

	// Message-guard and message-text families: the four isAssistantMessage defs
	// were divergent narrowings — omfg-rule keeps the plain AgentMessage ->
	// AssistantMessage guard; stats' id-requiring entry guard is
	// isLinkableAssistantEntry, acp's loose duck check is hasAssistantRole,
	// token-rate's usage-sampling guard is isSampledAssistantMessage. stats'
	// entry-level isToolResultMessage became isToolResultEntry (cursor keeps the
	// plain duck guard). Both extractUserText twins collapsed into utils
	// textFromContent (string passthrough + joinTextBlocks; stats joins with ""),
	// and cursor's role-guarded extractAssistantMessageText became
	// assistantMessageText delegating to joinTextBlocks (acp keeps the exported
	// structured-text variant, which also reads text off non-text blocks).
	it("message guards and message-text extractors each have one owner", async () => {
		expect(await findDefinitions(/function\s+isAssistantMessage\b/)).toEqual([
			"coding-agent/src/modes/controllers/omfg-rule.ts",
		]);
		expect(await findDefinitions(/function\s+isToolResultMessage\b/)).toEqual(["ai/src/providers/cursor.ts"]);
		expect(await findDefinitions(/function\s+isLinkableAssistantEntry\b/)).toEqual(["stats/src/parser.ts"]);
		expect(await findDefinitions(/function\s+hasAssistantRole\b/)).toEqual([
			"coding-agent/src/modes/acp/acp-event-mapper.ts",
		]);
		expect(await findDefinitions(/function\s+isSampledAssistantMessage\b/)).toEqual([
			"coding-agent/src/modes/components/status-line/token-rate.ts",
		]);
		expect(await findDefinitions(/function\s+extractUserText\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+extractAssistantText\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+textFromContent\b/)).toEqual(["utils/src/text-blocks.ts"]);
		// title-context trims each block, drops empties, and joins with "\n\n" — a title-normalizing contract.
		expect(await findDefinitions(/function\s+trimmedTextFromContent\b/)).toEqual([
			"coding-agent/src/session/title-context.ts",
		]);
		expect(await findDefinitions(/function\s+extractAssistantMessageText\b/)).toEqual([
			"coding-agent/src/modes/acp/acp-event-mapper.ts",
		]);
		expect(await findDefinitions(/function\s+assistantMessageText\b/)).toEqual(["ai/src/providers/cursor.ts"]);
	});

	// invalidate() is a designed module-namespace verb, not a dup: four exported
	// functions with unrelated contracts (beam memory supersession, capability fs
	// cache eviction, the capability facade that path-resolves then delegates to
	// the fs one, github view-cache row deletion), each consumed through its
	// module/class namespace. This lock pins the set so a fifth same-name export
	// gets triaged instead of silently joining the pile.
	it("invalidate stays limited to the four documented module-namespace APIs", async () => {
		expect(await findDefinitions(/function\s+invalidate\b/)).toEqual([
			"coding-agent/src/capability/fs.ts",
			"coding-agent/src/capability/index.ts",
			"coding-agent/src/tools/github-cache.ts",
			"mnemopi/src/core/beam/store.ts",
		]);
	});

	// openDb twins renamed to their stores (openModelCacheDb throws/creates,
	// openGithubCacheDb is best-effort null). loadExtensions: the two discovery
	// defs are per-source implementations of the discovery loader pattern (each
	// source module registers its own loadX via \`load:\`), extensibility/loader
	// owns the public extension-file loader, and mnemopi's unrelated SQLite
	// native-extension helper became loadSqliteExtensions. buildSystemPrompt:
	// system-prompt.ts owns it; sdk.ts is a same-name public facade delegating to
	// it (documented); the ai provider defs were renamed to their real contracts
	// (parseAnthropicSystemPrompt normalizes an inbound AnthropicSystem payload,
	// buildBedrockSystemBlocks builds outbound SystemContent with cache points).
	it("db-open, extension-load, and system-prompt builders each have one owner", async () => {
		expect(await findDefinitions(/function\s+openDb\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+openModelCacheDb\b/)).toEqual(["catalog/src/model-cache.ts"]);
		expect(await findDefinitions(/function\s+openGithubCacheDb\b/)).toEqual([
			"coding-agent/src/tools/github-cache.ts",
		]);
		expect(await findDefinitions(/function\s+loadExtensions\b/)).toEqual([
			"coding-agent/src/discovery/builtin.ts",
			"coding-agent/src/discovery/gemini.ts",
			"coding-agent/src/extensibility/extensions/loader.ts",
		]);
		expect(await findDefinitions(/function\s+loadSqliteExtensions\b/)).toEqual(["mnemopi/src/db.ts"]);
		expect(await findDefinitions(/function\s+buildSystemPrompt\b/)).toEqual([
			"coding-agent/src/sdk.ts",
			"coding-agent/src/system-prompt.ts",
		]);
		expect(await findDefinitions(/function\s+parseAnthropicSystemPrompt\b/)).toEqual([
			"ai/src/providers/anthropic-messages-server.ts",
		]);
		expect(await findDefinitions(/function\s+buildBedrockSystemBlocks\b/)).toEqual([
			"ai/src/providers/amazon-bedrock.ts",
		]);
	});

	// Usage-status thresholds (>= 1 exhausted, >= 0.8 warning) were tripled
	// across usage-cli (twice) and opencode-go; ai/src/usage.ts
	// usageStatusFromFraction now owns them, with usage-cli's status-or-derive
	// wrapper renamed resolveLimitStatus. The generic-verb module-local
	// normalizers (normalizeConfig/normalizeContent/parseMetadata and the
	// divergent normalizeImportance pair with different defaults, 0.5 vs 0.75)
	// were renamed to their domain contracts.
	it("usage thresholds and domain normalizers each have one owner", async () => {
		expect(await findDefinitions(/function\s+resolveStatus\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+usageStatusFromFraction\b/)).toEqual(["ai/src/usage.ts"]);
		expect(await findDefinitions(/function\s+resolveLimitStatus\b/)).toEqual(["coding-agent/src/cli/usage-cli.ts"]);
		expect(await findDefinitions(/function\s+normalizeConfig\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+normalizeContent\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+parseMetadata\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+normalizeImportance\b/)).toEqual(["mnemopi/src/core/beam/helpers.ts"]);
		expect(await findDefinitions(/function\s+importanceOrDefault\b/)).toEqual([
			"coding-agent/src/mnemopi/backend.ts",
		]);
		expect(await findDefinitions(/function\s+normalizeDapConfig\b/)).toEqual(["coding-agent/src/dap/config.ts"]);
		expect(await findDefinitions(/function\s+normalizeLspConfig\b/)).toEqual(["coding-agent/src/lsp/config.ts"]);
		expect(await findDefinitions(/function\s+normalizeBeamConfig\b/)).toEqual(["mnemopi/src/core/beam/index.ts"]);
		expect(await findDefinitions(/function\s+normalizeMockContent\b/)).toEqual(["ai/src/providers/mock.ts"]);
		expect(await findDefinitions(/function\s+parseRecallMetadata\b/)).toEqual([
			"mnemopi/src/core/polyphonic-recall.ts",
		]);
		expect(await findDefinitions(/function\s+parsePasteMetadata\b/)).toEqual([
			"coding-agent/src/utils/enhanced-paste.ts",
		]);
	});

	// Generic-verb sweep across formatDate/parseNumber/getProjectId/etc: every
	// pair was divergent, so each def was renamed to its real contract; the two
	// byte-identical hasLocalLoopbackBaseUrl copies were hoisted to utils/url.ts,
	// and the finite-number own-property read (numberField twins) became
	// getFiniteNumberProperty in utils/type-guards.ts (gitlab-duo-workflow's
	// non-negative variant delegates; the legacy shim keeps its loose
	// prototype-walking numberField as sole owner). summarizeToolResult in
	// tool-call-loop-guard keeps the name (find + join + truncate) and now joins
	// via joinTextBlocks; the js tool-bridge status builder is
	// toolResultStatusEvent.
	it("generic-verb helpers each have one contract-named owner", async () => {
		expect(await findDefinitions(/function\s+formatDate\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+hasLocalLoopbackBaseUrl\b/)).toEqual(["utils/src/url.ts"]);
		expect(await findDefinitions(/function\s+getFiniteNumberProperty\b/)).toEqual(["utils/src/type-guards.ts"]);
		expect(await findDefinitions(/function\s+numberField\b/)).toEqual([
			"coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
		]);
		expect(await findDefinitions(/function\s+nonNegativeNumberField\b/)).toEqual([
			"ai/src/providers/gitlab-duo-workflow.ts",
		]);
		expect(await findDefinitions(/function\s+parseNumber\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+getProjectId\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+summarizeToolResult\b/)).toEqual([
			"ai/src/utils/tool-call-loop-guard.ts",
		]);
		expect(await findDefinitions(/function\s+buildPrompt\b/)).toEqual(["mnemopi/src/core/local-llm.ts"]);
		expect(await findDefinitions(/function\s+buildRequest\b/)).toEqual(["ai/src/providers/google-gemini-cli.ts"]);
		expect(await findDefinitions(/function\s+startServer\b/)).toEqual(["stats/src/server.ts"]);
		expect(await findDefinitions(/function\s+handleGet\b/)).toEqual(["mnemopi/src/mcp-tools.ts"]);
		expect(await findDefinitions(/function\s+handleToolCall\b/)).toEqual(["mnemopi/src/mcp-tools.ts"]);
		expect(await findDefinitions(/function\s+compile\b/)).toEqual(["utils/src/prompt.ts"]);
		expect(await findDefinitions(/function\s+formatContext\b/)).toEqual(["mnemopi/src/core/beam/recall.ts"]);
		expect(await findDefinitions(/function\s+resolveCallbackOptions\b/)).toEqual([
			"coding-agent/src/mcp/oauth-flow.ts",
		]);
	});

	// Per-binary CLI entry scaffolding is designed repetition, not duplication:
	// each executable owns its main/runCli/printHelp. usage() is two unrelated
	// domain contracts (mnemopi's exiting CLI-error helper vs the slash-command
	// usage responder). Pinned so new same-name entries get triaged.
	it("designed per-language and per-provider families stay at their documented inventories", async () => {
		// Per-language kernel lifecycle verbs: each executor owns its session map
		// and kernel type; a new definition elsewhere needs triage.
		const evalExecutors = [
			"coding-agent/src/eval/jl/executor.ts",
			"coding-agent/src/eval/py/executor.ts",
			"coding-agent/src/eval/rb/executor.ts",
		];
		expect(await findDefinitions(/function\s+startKernel\b/)).toEqual(evalExecutors);
		expect(await findDefinitions(/function\s+resetSession\b/)).toEqual(evalExecutors);
		expect(await findDefinitions(/function\s+replaceSessionKernel\b/)).toEqual(evalExecutors);
		// Per-dialect tool-call renderers (anthropic/minimax/xml wire formats).
		const dialects = ["ai/src/dialect/anthropic.ts", "ai/src/dialect/minimax.ts", "ai/src/dialect/xml.ts"];
		expect(await findDefinitions(/function\s+renderInvoke\b/)).toEqual(dialects);
		expect(await findDefinitions(/function\s+renderInvokes\b/)).toEqual(dialects);
		// Per-engine HTML SERP parsers: each provider parses its own markup.
		expect(await findDefinitions(/function\s+parseHtmlResults\b/)).toEqual([
			"coding-agent/src/web/search/providers/duckduckgo.ts",
			"coding-agent/src/web/search/providers/ecosia.ts",
			"coding-agent/src/web/search/providers/google.ts",
			"coding-agent/src/web/search/providers/mojeek.ts",
			"coding-agent/src/web/search/providers/startpage.ts",
		]);
	});

	it("2x dedup slice: durations, errors, locations, positions, clones, usage, workers stay single-owner", async () => {
		expect(await findDefinitions(/function\s+formatDuration\b/)).toEqual(["utils/src/format.ts"]);
		expect(await findDefinitions(/function\s+formatCoarseDuration\b/)).toEqual([
			"coding-agent/src/slash-commands/helpers/format.ts",
		]);
		expect(await findDefinitions(/function\s+formatErrorMessage\b/)).toEqual([
			"coding-agent/src/tools/render-utils.ts",
		]);
		expect(await findDefinitions(/function\s+formatLocation\b/)).toEqual(["coding-agent/src/lsp/utils.ts"]);
		expect(await findDefinitions(/function\s+formatDapLocation\b/)).toEqual(["coding-agent/src/tools/debug.ts"]);
		expect(await findDefinitions(/function\s+comparePosition\b/)).toEqual(["coding-agent/src/lsp/utils.ts"]);
		expect(await findDefinitions(/function\s+canonicalProjectDir\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+canonicalizePath\b/)).toEqual(["utils/src/path.ts"]);
		expect(await findDefinitions(/function\s+cloneToolCall\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+cloneCanonicalToolCall\b/)).toEqual(["ai/src/dialect/owned-stream.ts"]);
		expect(await findDefinitions(/function\s+shallowCloneToolCall\b/)).toEqual([
			"ai/src/utils/leaked-thinking-stream.ts",
		]);
		expect(await findDefinitions(/function\s+emptyUsage\b/)).toEqual(["ai/src/types.ts"]);
		expect(await findDefinitions(/function\s+detectLanguage\b/)).toEqual(["mnemopi/src/core/beam/helpers.ts"]);
		expect(await findDefinitions(/function\s+enqueueRequest\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+enqueueTtsRequest\b/)).toEqual(["coding-agent/src/tts/tts-worker.ts"]);
		expect(await findDefinitions(/function\s+enqueueTinyTitleRequest\b/)).toEqual([
			"coding-agent/src/tiny/worker.ts",
		]);
		expect(await findDefinitions(/function\s+handleQueuedRequest\b/)).toEqual([]);
	});

	it("2x dedup slice B: azure, indent, banks, vcs and provider builders stay single-owner", async () => {
		expect(await findDefinitions(/function\s+appendAzureApiVersion\b/)).toEqual([
			"agent/src/compaction/compaction-v2-streaming.ts",
		]);
		expect(await findDefinitions(/function\s+resolveAzureOpenAiBaseUrl\b/)).toEqual([
			"agent/src/compaction/compaction-v2-streaming.ts",
		]);
		expect(await findDefinitions(/function\s+applyIndentDelta\b/)).toEqual(["coding-agent/src/edit/normalize.ts"]);
		expect(await findDefinitions(/function\s+isBlankLine\b/)).toEqual(["coding-agent/src/edit/normalize.ts"]);
		expect(await findDefinitions(/function\s+isNonEmptyLine\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+bankDbPath\b/)).toEqual(["mnemopi/src/core/banks.ts"]);
		expect(await findDefinitions(/function\s+buildDiffArgs\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+buildGitDiffArgs\b/)).toEqual(["coding-agent/src/utils/git.ts"]);
		expect(await findDefinitions(/function\s+buildJjDiffArgs\b/)).toEqual(["coding-agent/src/utils/jj.ts"]);
		expect(await findDefinitions(/function\s+buildHeaders\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+buildModelsUrl\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+buildReleaseMarkdown\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+buildSearchUrl\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+buildRemoteCommand\b/)).toEqual([
			"coding-agent/src/ssh/connection-manager.ts",
		]);
		expect(await findDefinitions(/function\s+buildResult\b/)).toEqual(["coding-agent/src/web/scrapers/types.ts"]);
	});

	it("2x dedup slice C: usage builders, classifiers, memories, transformers stay single-owner", async () => {
		// buildTools/buildUsage are designed per-wire-format encoders of the two
		// OpenAI-compatible server modules (chat completions vs responses API).
		expect(await findDefinitions(/function\s+buildTools\b/)).toEqual([
			"ai/src/providers/openai-chat-server.ts",
			"ai/src/providers/openai-responses-server.ts",
		]);
		expect(await findDefinitions(/function\s+buildUsage\b/)).toEqual([
			"ai/src/providers/openai-chat-server.ts",
			"ai/src/providers/openai-responses-server.ts",
		]);
		expect(await findDefinitions(/function\s+buildUsageLimit\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+buildWindow\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+cacheStats\b/)).toEqual(["coding-agent/src/capability/fs.ts"]);
		expect(await findDefinitions(/function\s+callMeta\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+canvasToString\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+clampLimit\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+clampVeracity\b/)).toEqual([
			"mnemopi/src/core/veracity-consolidation.ts",
		]);
		expect(await findDefinitions(/function\s+classifyLocal\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+classifyOnline\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+clearMemoryData\b/)).toEqual(["coding-agent/src/memories/index.ts"]);
		expect(await findDefinitions(/function\s+clearMemoryTables\b/)).toEqual(["coding-agent/src/memories/storage.ts"]);
		expect(await findDefinitions(/function\s+collectReferencedPaths\b/)).toEqual([
			"coding-agent/src/extensibility/plugins/installed-registry.ts",
		]);
		expect(await findDefinitions(/function\s+compareCredentialBlockSnapshots\b/)).toEqual([
			"ai/src/auth-broker/types.ts",
		]);
		expect(await findDefinitions(/function\s+computeContextBreakdown\b/)).toEqual([
			"coding-agent/src/modes/utils/context-usage.ts",
		]);
		expect(await findDefinitions(/function\s+computeContextUsageBreakdown\b/)).toEqual([
			"coding-agent/src/session/session-stats.ts",
		]);
		expect(await findDefinitions(/function\s+configureTransformers\b/)).toEqual([
			"coding-agent/src/subprocess/worker-runtime.ts",
		]);
	});

	it("cross-package 2x dedup slice D: hoisted owners stay single and old twin names stay dead", async () => {
		// Hoisted owners (one definition each).
		expect(await findDefinitions(/function\s+enoentError\b/)).toEqual(["utils/src/fs-error.ts"]);
		expect(await findDefinitions(/function\s+commandFailureMessage\b/)).toEqual(["utils/src/process.ts"]);
		expect(await findDefinitions(/function\s+geminiTurn\b/)).toEqual(["ai/src/dialect/rendering.ts"]);
		expect(await findDefinitions(/function\s+envDisabled\b/)).toEqual(["mnemopi/src/util/env.ts"]);
		expect(await findDefinitions(/function\s+findPhaseFuzzy\b/)).toEqual([
			"coding-agent/src/slash-commands/helpers/todo.ts",
		]);
		expect(await findDefinitions(/function\s+findTaskFuzzy\b/)).toEqual([
			"coding-agent/src/slash-commands/helpers/todo.ts",
		]);
		expect(await findDefinitions(/function\s+errorFromWorkerEvent\b/)).toEqual([
			"coding-agent/src/subprocess/worker-client.ts",
		]);
		// Installed-plugins registry: one type + reader owner for both the plugin
		// manager and the marketplace stack (marketplace re-exports).
		expect(await findDefinitions(/function\s+emptyInstalledPluginsRegistry\b/)).toEqual([
			"coding-agent/src/extensibility/plugins/installed-registry.ts",
		]);
		expect(await findDefinitions(/function\s+readInstalledPluginsRegistry\b/)).toEqual([
			"coding-agent/src/extensibility/plugins/installed-registry.ts",
		]);
		expect(await findDefinitions(/interface\s+InstalledPluginsRegistry\b/)).toEqual([
			"coding-agent/src/extensibility/plugins/installed-registry.ts",
		]);
		// Shared bearer-token bootstrap for auth-broker/auth-gateway CLIs (the
		// gateway's race-safe exclusive-create flow, now used by both).
		expect(await findDefinitions(/function\s+ensureServiceToken\b/)).toEqual([
			"coding-agent/src/cli/service-token.ts",
		]);
		expect(await findDefinitions(/function\s+ensureToken\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+readToken\b/)).toEqual([]);
		// Embedding env config: config.ts owns env semantics; core/embeddings.ts is
		// the runtime-options-aware layer that delegates to it (designed pair).
		expect(await findDefinitions(/function\s+embeddingsDisabled\b/)).toEqual([
			"mnemopi/src/config.ts",
			"mnemopi/src/core/embeddings.ts",
		]);
		expect(await findDefinitions(/function\s+embeddingApiKey\b/)).toEqual([
			"mnemopi/src/config.ts",
			"mnemopi/src/core/embeddings.ts",
		]);
		// Divergent same-name twins renamed to contract-revealing names.
		expect(await findDefinitions(/function\s+createDefaultRuntime\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+createRequestSetup\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+defaultConvertToLlm\b/)).toEqual(["agent/src/compaction/messages.ts"]);
		expect(await findDefinitions(/function\s+describeBrowser\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+discoverProject\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+emitEvent\b/)).toEqual(["mnemopi/src/core/beam/store.ts"]);
		expect(await findDefinitions(/function\s+errorPayload\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+filterExcludedFiles\b/)).toEqual([
			"coding-agent/src/commit/utils/exclusions.ts",
		]);
		expect(await findDefinitions(/function\s+formatTrack\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+formatLabels\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+formatRunLine\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+formatSearchResults\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+formatValue\b/)).toEqual([]);
		// Designed polymorphism pinned as-is: the documented legacy shim
		// delegating to the real SDK entry point.
		expect(await findDefinitions(/function\s+fileConfigSource\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+createAgentSession\b/)).toEqual([
			"coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
			"coding-agent/src/sdk.ts",
		]);
	});

	it("cross-package 2x dedup slice E: hoisted owners stay single and old twin names stay dead", async () => {
		// Hoisted owners.
		expect(await findDefinitions(/function\s+gemmaTurn\b/)).toEqual(["ai/src/dialect/rendering.ts"]);
		expect(await findDefinitions(/function\s+gcd\b/)).toEqual(["coding-agent/src/edit/normalize.ts"]);
		expect(await findDefinitions(/function\s+ensureCommandAvailable\b/)).toEqual(["utils/src/process.ts"]);
		expect(await findDefinitions(/function\s+ensureAvailable\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+currentBranchOrHead\b/)).toEqual(["coding-agent/src/utils/git.ts"]);
		expect(await findDefinitions(/function\s+getCurrentBranch\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+jwtExpiryMs\b/)).toEqual(["ai/src/utils/jwt.ts"]);
		expect(await findDefinitions(/function\s+getTokenExpiry\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+getToolResultMessage\b/)).toEqual(["agent/src/compaction/messages.ts"]);
		// Executor deadline helpers: base owns the generic pair; Julia's variants
		// carry documented divergences (timeoutMs<=0 disabled, clamped remaining).
		expect(await findDefinitions(/function\s+getExecutionDeadlineMs\b/)).toEqual([
			"coding-agent/src/eval/executor-base.ts",
		]);
		expect(await findDefinitions(/function\s+getRemainingTimeoutMs\b/)).toEqual([
			"coding-agent/src/eval/executor-base.ts",
		]);
		// Divergent same-name twins renamed to contract-revealing names.
		expect(await findDefinitions(/function\s+generateCompletion\b/)).toEqual([
			"coding-agent/src/cli/completion-gen.ts",
		]);
		expect(await findDefinitions(/function\s+getConfigDirs\b/)).toEqual(["coding-agent/src/config.ts"]);
		expect(await findDefinitions(/function\s+generateSummary\b/)).toEqual(["agent/src/compaction/compaction.ts"]);
		expect(await findDefinitions(/function\s+getMessageFromEntry\b/)).toEqual(["agent/src/compaction/compaction.ts"]);
		expect(await findDefinitions(/function\s+clean\b/)).toEqual(["coding-agent/src/utils/git.ts"]);
		expect(await findDefinitions(/function\s+err\b/)).toEqual(["mnemopi/src/cli.ts"]);
		// Designed layering pinned as-is: the SDK's buildSystemPrompt is a public
		// wrapper over the internal system-prompt builder.
		expect(await findDefinitions(/function\s+buildSystemPrompt\b/)).toEqual([
			"coding-agent/src/sdk.ts",
			"coding-agent/src/system-prompt.ts",
		]);
	});

	it("cross-package 2x dedup slice F: hoisted owners stay single and old twin names stay dead", async () => {
		// Config-file plumbing hoisted from dap/lsp into one owner module.
		expect(await findDefinitions(/function\s+parseConfigContent\b/)).toEqual([
			"coding-agent/src/config/config-file.ts",
		]);
		expect(await findDefinitions(/function\s+readConfigFile\b/)).toEqual(["coding-agent/src/config/config-file.ts"]);
		expect(await findDefinitions(/function\s+configFileSource\b/)).toEqual([
			"coding-agent/src/config/config-file.ts",
		]);
		// Designed per-domain wiring pinned as-is: each surface assembles its own
		// source list (lsp's also reads marketplace plugin roots).
		expect(await findDefinitions(/function\s+getConfigSources\b/)).toEqual([
			"coding-agent/src/dap/config.ts",
			"coding-agent/src/lsp/config.ts",
		]);
		// Marketplace re-exports installed-registry's id helpers instead of copies.
		expect(await findDefinitions(/function\s+isValidNameSegment\b/)).toEqual([
			"coding-agent/src/extensibility/plugins/installed-registry.ts",
		]);
		expect(await findDefinitions(/function\s+parsePluginId\b/)).toEqual([
			"coding-agent/src/extensibility/plugins/installed-registry.ts",
		]);
		// Kimi dialect rendering helpers hoisted into the shared rendering module.
		expect(await findDefinitions(/function\s+kimiTurn\b/)).toEqual(["ai/src/dialect/rendering.ts"]);
		expect(await findDefinitions(/function\s+kimiCallId\b/)).toEqual(["ai/src/dialect/rendering.ts"]);
		expect(await findDefinitions(/function\s+isAsciiWhitespace\b/)).toEqual(["ai/src/dialect/rendering.ts"]);
		// Divergent lexical-grammar scanners renamed per dialect.
		expect(await findDefinitions(/function\s+splitTopLevel\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+topLevelIndexOf\b/)).toEqual([]);
		// Eval cancellation trio lives only in the parameterized base.
		expect(await findDefinitions(/function\s+isCancellationError\b/)).toEqual([
			"coding-agent/src/eval/executor-base.ts",
		]);
		expect(await findDefinitions(/function\s+isTimedOutCancellation\b/)).toEqual([
			"coding-agent/src/eval/executor-base.ts",
		]);
		expect(await findDefinitions(/function\s+waitForPromiseWithCancellation\b/)).toEqual([
			"coding-agent/src/eval/executor-base.ts",
		]);
		// Worker lifecycle: shared timeout race and per-protocol payload builders;
		// per-domain worker wrappers renamed to contract-revealing names.
		expect(await findDefinitions(/function\s+raceWithTimeout\b/)).toEqual([
			"coding-agent/src/subprocess/worker-client.ts",
		]);
		expect(await findDefinitions(/function\s+jsRunErrorPayload\b/)).toEqual([
			"coding-agent/src/eval/js/worker-protocol.ts",
		]);
		expect(await findDefinitions(/function\s+toErrorPayload\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+wrapBunWorker\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+spawnInlineWorker\b/)).toEqual([]);
		// Designed per-VCS mirrors pinned as-is: each module binds its own runner,
		// error class, and result type (GitCommandError vs JjCommandError).
		expect(await findDefinitions(/function\s+runChecked\b/)).toEqual([
			"coding-agent/src/utils/git.ts",
			"coding-agent/src/utils/jj.ts",
		]);
		expect(await findDefinitions(/function\s+runText\b/)).toEqual([
			"coding-agent/src/utils/git.ts",
			"coding-agent/src/utils/jj.ts",
		]);
		// Designed layering pinned as-is: memory.ts is the default-instance public
		// facade; beam/store.ts holds the engine primitives over BeamMemoryState.
		for (const name of ["get", "getContext", "remember", "scratchpadRead", "scratchpadWrite", "scratchpadClear"]) {
			expect(await findDefinitions(new RegExp(`function\\s+${name}\\b`))).toEqual([
				"mnemopi/src/core/beam/store.ts",
				"mnemopi/src/core/memory.ts",
			]);
		}
		// Same facade layering for the engine tails that live outside store.ts:
		// beam/recall.ts owns recall, beam/consolidate.ts owns sleep.
		for (const name of ["recall", "recallEnhanced"]) {
			expect(await findDefinitions(new RegExp(`function\\s+${name}\\b`))).toEqual([
				"mnemopi/src/core/beam/recall.ts",
				"mnemopi/src/core/memory.ts",
			]);
		}
		for (const name of ["sleep", "sleepAllSessions"]) {
			expect(await findDefinitions(new RegExp(`function\\s+${name}\\b`))).toEqual([
				"mnemopi/src/core/beam/consolidate.ts",
				"mnemopi/src/core/memory.ts",
			]);
		}
		// Bank selection state has ONE owner (banks.ts defaultBank); memory.ts
		// getBank/setBank are facade delegates that also recycle the default
		// instance. Two state variables here was a live bug (facade setBank
		// never reached bankDbPath's default arg).
		for (const name of ["getBank", "setBank"]) {
			expect(await findDefinitions(new RegExp(`function\\s+${name}\\b`))).toEqual([
				"mnemopi/src/core/banks.ts",
				"mnemopi/src/core/memory.ts",
			]);
		}
		// Designed per-binary CLI verb handlers pinned as-is: broker and gateway
		// each dispatch their own service's subcommands.
		for (const name of ["runServe", "runToken", "runStatus"]) {
			expect(await findDefinitions(new RegExp(`function\\s+${name}\\b`))).toEqual([
				"coding-agent/src/cli/auth-broker-cli.ts",
				"coding-agent/src/cli/auth-gateway-cli.ts",
			]);
		}
		// LLM env knobs: config.ts owns the env reads; local-llm.ts layers
		// runtime-option overrides on top (designed pair, like embeddings).
		for (const name of ["llmBaseUrl", "llmApiKey"]) {
			expect(await findDefinitions(new RegExp(`function\\s+${name}\\b`))).toEqual([
				"mnemopi/src/config.ts",
				"mnemopi/src/core/local-llm.ts",
			]);
		}
		expect(await findDefinitions(/function\s+sleepPrompt\b/)).toEqual(["mnemopi/src/config.ts"]);
		expect(await findDefinitions(/function\s+hostLlmContextTokens\b/)).toEqual([]);
		// SQLite plumbing: db.ts owns placeholders; annotations.ts owns the
		// annotations DDL; diagnose's view-inclusive probe carries its own name.
		expect(await findDefinitions(/function\s+placeholders\b/)).toEqual(["mnemopi/src/db.ts"]);
		expect(await findDefinitions(/function\s+initAnnotations\b/)).toEqual(["mnemopi/src/core/annotations.ts"]);
		expect(await findDefinitions(/function\s+hasTable\b/)).toEqual([
			"mnemopi/src/core/migrations/e6-triplestore-split.ts",
		]);
		expect(await findDefinitions(/function\s+hasTableOrView\b/)).toEqual(["mnemopi/src/diagnose.ts"]);
		// Catalog provider plumbing: utils.ts owns the undefined-convention
		// coercers; codex discovery's null-convention locals carry their own
		// names; ai keeps the canonical usage-endpoint base-url normalizer.
		expect(await findDefinitions(/function\s+toNonEmptyString\b/)).toEqual(["catalog/src/utils.ts"]);
		expect(await findDefinitions(/function\s+toBoolean\b/)).toEqual(["catalog/src/utils.ts"]);
		expect(await findDefinitions(/function\s+normalizeCodexBaseUrl\b/)).toEqual([
			"ai/src/usage/openai-codex-base-url.ts",
		]);
		expect(await findDefinitions(/function\s+normalizeCodexDiscoveryBaseUrl\b/)).toEqual([
			"catalog/src/discovery/codex.ts",
		]);
		// Documented bootstrap-free copy pinned as-is: cli.ts keeps a local
		// startupMarker so the --version import graph stays winston-free.
		expect(await findDefinitions(/function\s+startupMarker\b/)).toEqual(["utils/src/cli.ts", "utils/src/logger.ts"]);
		// Hoisted owners and divergence renames (batch 2).
		expect(await findDefinitions(/function\s+sha256Hex16\b/)).toEqual(["mnemopi/src/util/ids.ts"]);
		expect(await findDefinitions(/function\s+quoteShellArg\b/)).toEqual(["utils/src/process.ts"]);
		expect(await findDefinitions(/function\s+safeJsonStringify\b/)).toEqual([
			"coding-agent/src/tools/browser/run-output.ts",
		]);
		expect(await findDefinitions(/function\s+withTimeoutSignal\b/)).toEqual([
			"coding-agent/src/utils/fetch-timeout.ts",
		]);
		// Documented legacy shim wrapper over the utils frontmatter owner.
		expect(await findDefinitions(/function\s+parseFrontmatter\b/)).toEqual([
			"coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
			"utils/src/frontmatter.ts",
		]);
		// Codex-specific header helpers renamed off the generic debug owners.
		expect(await findDefinitions(/function\s+headersToRecord\b/)).toEqual(["ai/src/utils/request-debug.ts"]);
		expect(await findDefinitions(/function\s+redactHeaders\b/)).toEqual(["ai/src/utils/http-inspector.ts"]);
		// Accelerated-device pipeline fallback owned by the shared worker runtime;
		// stt/tiny workers pass loadOnDevice closures (stt gained CUDA diagnostics).
		expect(await findDefinitions(/function\s+loadPipelineWithDeviceFallback\b/)).toEqual([
			"coding-agent/src/subprocess/worker-runtime.ts",
		]);
		expect(await findDefinitions(/function\s+loadPipelineOnDevice\b/)).toEqual([]);
		// Plugin package-name validation owned by parser.ts (superset that strips
		// version specifiers); installer/manager import it.
		expect(await findDefinitions(/function\s+validatePackageName\b/)).toEqual([
			"coding-agent/src/extensibility/plugins/parser.ts",
		]);
		expect(await findDefinitions(/function\s+titleCaseSentence\b/)).toEqual([
			"coding-agent/src/slash-commands/helpers/todo.ts",
		]);
		// Task renderer keeps its sanitizing tree variant under its own names.
		expect(await findDefinitions(/function\s+renderJsonTreeLines\b/)).toEqual([
			"coding-agent/src/tools/json-tree.ts",
		]);
		expect(await findDefinitions(/function\s+buildTreePrefix\b/)).toEqual(["coding-agent/src/tui/utils.ts"]);
		// JSON parse-or-null twins collapsed onto utils tryParseJson.
		expect(await findDefinitions(/function\s+parseJsonContent\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+safeJsonParse\b/)).toEqual([]);
		// Per-engine SERP redirect unwrappers renamed to their contracts.
		expect(await findDefinitions(/function\s+unwrapResultUrl\b/)).toEqual([]);
		// GitLab OAuth token mapping owned by gitlab-duo.ts, parameterized by provider.
		expect(await findDefinitions(/function\s+mapTokenResponse\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+mapGitLabTokenResponse\b/)).toEqual([
			"ai/src/registry/oauth/gitlab-duo.ts",
		]);
		// Binary-search lower bound owned by utils; byte-limit clamp owned by
		// session-storage (indexed passes an infinite size).
		expect(await findDefinitions(/function\s+lowerBound\b/)).toEqual(["utils/src/search.ts"]);
		expect(await findDefinitions(/function\s+normalizeByteLimit\b/)).toEqual([
			"coding-agent/src/session/session-storage.ts",
		]);
		// Divergence renames: lock-file basename check, CRLF-tolerant recorded-line
		// match, error-swallowing repo-resolution wrappers.
		expect(await findDefinitions(/function\s+isExcludedFile\b/)).toEqual([
			"coding-agent/src/commit/utils/exclusions.ts",
		]);
		expect(await findDefinitions(/function\s+matchesAt\b/)).toEqual(["coding-agent/src/edit/modes/replace.ts"]);
		expect(await findDefinitions(/function\s+resolveRepository\b/)).toEqual(["coding-agent/src/utils/git.ts"]);
		expect(await findDefinitions(/function\s+resolveRepositorySync\b/)).toEqual(["coding-agent/src/utils/git.ts"]);
		expect(await findDefinitions(/function\s+stripAnsi\b/)).toEqual(["utils/src/strip-ansi.ts"]);
		expect(await findDefinitions(/function\s+isExcludedLockFile\b/)).toEqual([
			"coding-agent/src/commit/agentic/tools/git-overview.ts",
		]);
		expect(await findDefinitions(/function\s+recordedLinesMatchAt\b/)).toEqual([
			"coding-agent/src/tools/conflict-detect.ts",
		]);
		expect(await findDefinitions(/function\s+tryResolveRepository\b/)).toEqual([
			"coding-agent/src/utils/active-repo-context.ts",
		]);
		expect(await findDefinitions(/function\s+tryJsonStringify\b/)).toEqual([
			"coding-agent/src/modes/acp/acp-event-mapper.ts",
		]);
		expect(await findDefinitions(/function\s+withScopedTimeoutSignal\b/)).toEqual([
			"coding-agent/src/config/model-discovery.ts",
		]);
		expect(await findDefinitions(/function\s+unwrapDdgResultUrl\b/)).toEqual([
			"coding-agent/src/web/search/providers/duckduckgo.ts",
		]);
		expect(await findDefinitions(/function\s+unwrapGoogleResultUrl\b/)).toEqual([
			"coding-agent/src/web/search/providers/google.ts",
		]);
		expect(await findDefinitions(/function\s+renderTaskJsonTreeLines\b/)).toEqual([
			"coding-agent/src/task/render.ts",
		]);
		// Usage-probe policy owners: the 90%/100% status thresholds and the OAuth
		// token short-circuit live once in ai/src/usage/shared.ts (was inlined in
		// seven provider files); toNumber's usage twin collapsed onto catalog.
		expect(await findDefinitions(/function\s+usageStatusFromUsedFraction\b/)).toEqual(["ai/src/usage/shared.ts"]);
		expect(await findDefinitions(/function\s+usageStatusFromRemainingFraction\b/)).toEqual([
			"ai/src/usage/shared.ts",
		]);
		expect(await findDefinitions(/function\s+resolveOAuthAccessToken\b/)).toEqual(["ai/src/usage/shared.ts"]);
		expect(await findDefinitions(/function\s+resolveAccessToken\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+getUsageStatus\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+buildUsageStatus\b/)).toEqual(["ai/src/usage/openai-codex.ts"]);
		expect(await findDefinitions(/function\s+deriveStatus\b/)).toEqual(["ai/src/usage/github-copilot.ts"]);
		expect(await findDefinitions(/(function|const)\s+toNumber\b/)).toEqual(["catalog/src/utils.ts"]);
		// Divergent per-provider parsers renamed to carry their provider.
		expect(await findDefinitions(/function\s+parseWindow\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+parseResetTime\b/)).toEqual([]);
		// JSON-object guard owned by schema/types.ts; thenable guard by utils/ipc.ts
		// (its doc declares it the shared home); method-not-found checks renamed to
		// carry their protocol (LSP message heuristic vs JSON-RPC -32601).
		expect(await findDefinitions(/function\s+isJsonObject\b/)).toEqual(["ai/src/utils/schema/types.ts"]);
		expect(await findDefinitions(/function\s+isThenable\b/)).toEqual(["coding-agent/src/utils/ipc.ts"]);
		expect(await findDefinitions(/function\s+isMethodNotFoundError\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+isUnsupportedLspMethodError\b/)).toEqual([
			"coding-agent/src/lsp/index.ts",
		]);
		expect(await findDefinitions(/function\s+isJsonRpcMethodNotFound\b/)).toEqual(["coding-agent/src/mcp/client.ts"]);
		// Schema-tree recursors renamed to carry their rewrite contract. The three
		// remaining `walk`s are unrelated private recursors over disjoint domains
		// (schema stamps, extension UI state, worktree fs) pinned as-is.
		expect(await findDefinitions(/function\s+walk\b/)).toEqual([
			"ai/src/utils/schema/stamps.ts",
			"coding-agent/src/modes/components/extensions/state-manager.ts",
			"coding-agent/src/task/worktree.ts",
		]);
		expect(await findDefinitions(/function\s+rewriteZodNode\b/)).toEqual([
			"ai/src/utils/schema/zod-decontaminate.ts",
		]);
		expect(await findDefinitions(/function\s+normalizeWireNode\b/)).toEqual(["ai/src/utils/schema/wire.ts"]);
		// Compaction request-timeout racer hoisted to the shared compaction utils.
		expect(await findDefinitions(/function\s+withRequestTimeout\b/)).toEqual(["agent/src/compaction/utils.ts"]);
		// Visible-content check: empty-completion-retry owns the thinking-excluding
		// contract; ollama's thinking-including variant carries its own name.
		expect(await findDefinitions(/function\s+hasVisibleAssistantContent\b/)).toEqual([
			"ai/src/utils/empty-completion-retry.ts",
		]);
		expect(await findDefinitions(/function\s+hasAnyAssistantContent\b/)).toEqual(["ai/src/providers/ollama.ts"]);
		// Skill-name handling: autolearn owns the strict throwing validator; the
		// memories coercer is a slug builder, named as one.
		expect(await findDefinitions(/function\s+sanitizeSkillName\b/)).toEqual([
			"coding-agent/src/autolearn/managed-skills.ts",
		]);
		expect(await findDefinitions(/function\s+skillNameSlug\b/)).toEqual(["coding-agent/src/memories/index.ts"]);
		// Schema normalizers: ai owns the generic options-based normalizeSchema;
		// the JTD result-shaped wrapper carries its dialect in its name.
		expect(await findDefinitions(/function\s+normalizeSchema\b/)).toEqual(["ai/src/utils/schema/normalize.ts"]);
		expect(await findDefinitions(/function\s+normalizeJtdSchema\b/)).toEqual([
			"coding-agent/src/tools/jtd-to-json-schema.ts",
		]);
		// Streaming tool-call sync helpers renamed to match their clone twins:
		// owned-stream canonicalizes fields, leaked-thinking preserves extras.
		expect(await findDefinitions(/function\s+syncToolCall\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+syncCanonicalToolCall\b/)).toEqual(["ai/src/dialect/owned-stream.ts"]);
		expect(await findDefinitions(/function\s+shallowSyncToolCall\b/)).toEqual([
			"ai/src/utils/leaked-thinking-stream.ts",
		]);
		// Kimi K2.7 Code family id pattern and matcher: one owner (was three
		// regex copies across both compat tables and provider-models).
		expect(await findDefinitions(/function\s+matchesKimiK27CodeFamily\b/)).toEqual(["catalog/src/compat/kimi.ts"]);
		expect(await findDefinitions(/function\s+isKimiK27CodeModelId\b/)).toEqual(["catalog/src/compat/kimi.ts"]);
		// CDP target-id helpers hoisted out of the tab worker/supervisor pair.
		expect(await findDefinitions(/function\s+targetIdForTarget\b/)).toEqual([
			"coding-agent/src/tools/browser/target-id.ts",
		]);
		expect(await findDefinitions(/function\s+targetIdForPage\b/)).toEqual([
			"coding-agent/src/tools/browser/target-id.ts",
		]);
		// Diff-hunk parsers renamed by contract: edit owns the single-file patch
		// parser name; the commit-side multi-file parser now carries the name its
		// consumer already aliased it to.
		expect(await findDefinitions(/function\s+parseDiffHunks\b/)).toEqual(["coding-agent/src/edit/diff.ts"]);
		expect(await findDefinitions(/function\s+parseCommitDiffHunks\b/)).toEqual([
			"coding-agent/src/commit/git/diff.ts",
		]);
		expect(await findDefinitions(/function\s+selectHunks\b/)).toEqual(["coding-agent/src/utils/git.ts"]);
		expect(await findDefinitions(/function\s+selectRequestedHunks\b/)).toEqual([
			"coding-agent/src/commit/agentic/tools/git-hunk.ts",
		]);
		// Bearer auth check: gateway/http.ts owns the timing-safe comparator; the
		// broker's plain Set.has copy was a timing side-channel and is gone.
		expect(await findDefinitions(/function\s+isAuthorized\b/)).toEqual(["ai/src/auth-gateway/http.ts"]);
		// SSE frame formatter and broker generation-tag parser: one owner each.
		expect(await findDefinitions(/function\s+sseEvent\b/)).toEqual(["ai/src/utils/sse.ts"]);
		expect(await findDefinitions(/function\s+parseGenerationTag\b/)).toEqual(["ai/src/auth-broker/wire-schemas.ts"]);
		// Metadata readers diverge on trimming; the trimming one says so.
		expect(await findDefinitions(/function\s+readMetadataString\b/)).toEqual(["ai/src/providers/anthropic.ts"]);
		expect(await findDefinitions(/function\s+readTrimmedMetadataString\b/)).toEqual([
			"ai/src/auth-broker/remote-store.ts",
		]);
		// Designed layering pinned as-is: error/retryable.ts owns the hook-based
		// classifier; anthropic's same-name wrapper injects the Copilot transient
		// hook the error module must not import.
		expect(await findDefinitions(/function\s+isProviderRetryableError\b/)).toEqual([
			"ai/src/error/retryable.ts",
			"ai/src/providers/anthropic.ts",
		]);
		// Null-variant checks diverge on input shape (anyOf variants array vs
		// whole schema); the schema-shaped one carries it in the name.
		expect(await findDefinitions(/function\s+hasNullVariant\b/)).toEqual(["ai/src/utils/schema/draft.ts"]);
		expect(await findDefinitions(/function\s+schemaHasNullVariant\b/)).toEqual(["ai/src/providers/anthropic.ts"]);
		// Launch protocol keeps its throwing validators; opencode's undefined-
		// convention readers say so in their names.
		expect(await findDefinitions(/function\s+stringArray\b/)).toEqual(["coding-agent/src/launch/protocol.ts"]);
		expect(await findDefinitions(/function\s+stringRecord\b/)).toEqual(["coding-agent/src/launch/protocol.ts"]);
		expect(await findDefinitions(/function\s+stringArrayOrUndefined\b/)).toEqual([
			"coding-agent/src/discovery/opencode.ts",
		]);
		expect(await findDefinitions(/function\s+stringRecordOrUndefined\b/)).toEqual([
			"coding-agent/src/discovery/opencode.ts",
		]);
		// Designed per-source discovery loaders pinned as-is (like git/jj verbs).
		expect(await findDefinitions(/function\s+loadInstructions\b/)).toEqual([
			"coding-agent/src/discovery/builtin.ts",
			"coding-agent/src/discovery/github.ts",
		]);
		expect(await findDefinitions(/function\s+loadBundledCommands\b/)).toEqual(["coding-agent/src/task/commands.ts"]);
		expect(await findDefinitions(/function\s+loadBundledCustomCommands\b/)).toEqual([
			"coding-agent/src/extensibility/custom-commands/loader.ts",
		]);
		// Designed per-subsystem embedding APIs pinned as-is: embeddings.ts owns
		// the batch matrix embed; shmr.ts owns its single-text vector embed.
		expect(await findDefinitions(/function\s+embed\b/)).toEqual([
			"mnemopi/src/core/embeddings.ts",
			"mnemopi/src/core/shmr.ts",
		]);
		// Non-null object guard (arrays pass, unlike isRecord) owned by pi-utils.
		expect(await findDefinitions(/function\s+isNonNullObject\b/)).toEqual(["utils/src/type-guards.ts"]);
		expect(await findDefinitions(/function\s+isObject\b/)).toEqual([]);
		// Error-message read and timeout-reason check: existing owners imported.
		expect(await findDefinitions(/function\s+toErrorMessage\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+isTimeoutReason\b/)).toEqual(["coding-agent/src/eval/kernel-base.ts"]);
		// HEAD-sha probe hoisted to autoresearch/git.ts.
		expect(await findDefinitions(/function\s+tryReadHeadSha\b/)).toEqual(["coding-agent/src/autoresearch/git.ts"]);
		// Display-text normalizers diverge (trailing-newline vs unknown-coercion +
		// CR strip); each carries its contract now.
		expect(await findDefinitions(/function\s+normalizeDisplayText\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+ensureTrailingNewline\b/)).toEqual([
			"coding-agent/src/eval/py/display.ts",
		]);
		expect(await findDefinitions(/function\s+coerceDisplayText\b/)).toEqual(["coding-agent/src/tools/write.ts"]);
		// Designed per-subsystem diagnostics snapshots pinned as-is.
		expect(await findDefinitions(/function\s+getDiagnostics\b/)).toEqual([
			"mnemopi/src/core/extraction/diagnostics.ts",
			"mnemopi/src/core/recall-diagnostics.ts",
		]);
		// Designed three-layer stats mirrors (db -> aggregator -> HTTP client).
		for (const name of ["getRecentErrors", "getRecentRequests"]) {
			expect(await findDefinitions(new RegExp(`function\\s+${name}\\b`))).toEqual([
				"stats/src/aggregator.ts",
				"stats/src/client/api.ts",
				"stats/src/db.ts",
			]);
		}
		// mnemopi divergence renames: cli keeps resolveDbPath (returns a real
		// path); memory's optional override, the two content comparators, the
		// null-passing metadata serializer, and the substring-only relevance
		// scorer all carry their contracts now.
		expect(await findDefinitions(/function\s+resolveDbPath\b/)).toEqual(["mnemopi/src/cli.ts"]);
		expect(await findDefinitions(/function\s+resolveDbPathOverride\b/)).toEqual(["mnemopi/src/core/memory.ts"]);
		expect(await findDefinitions(/function\s+sameContent\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+sameContentSnapshot\b/)).toEqual(["mnemopi/src/core/triples.ts"]);
		expect(await findDefinitions(/function\s+sameAnnotationContent\b/)).toEqual(["mnemopi/src/core/annotations.ts"]);
		expect(await findDefinitions(/function\s+metadataJson\b/)).toEqual(["mnemopi/src/core/beam/helpers.ts"]);
		expect(await findDefinitions(/function\s+metadataJsonOrNull\b/)).toEqual(["mnemopi/src/core/beam/store.ts"]);
		// helpers.ts's lexicalRelevance/strictFactMatches were the orphaned
		// predecessors of recall.ts's live scorers — removed, must not return.
		expect(await findDefinitions(/function\s+lexicalRelevance\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+strictFactMatches\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+substringLexicalRelevance\b/)).toEqual([
			"mnemopi/src/core/beam/recall.ts",
		]);
		// Identity normalization (trim + lowercase or undefined): one owner;
		// codex-auto-reset's byte-identical mirror imports it now.
		expect(await findDefinitions(/function\s+normalizeIdentityValue\b/)).toEqual([
			"coding-agent/src/slash-commands/helpers/active-oauth-account.ts",
		]);
		expect(await findDefinitions(/function\s+normalize\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+trimToUndefined\b/)).toEqual([]);
		// Config-value resolution: the async cached owner keeps the name; the
		// models.yml sync path says so. The CLI verb keeps runShellCommand; the
		// stdout-capturing helper says what it does.
		expect(await findDefinitions(/function\s+resolveConfigValue\b/)).toEqual([
			"coding-agent/src/config/resolve-config-value.ts",
		]);
		expect(await findDefinitions(/function\s+resolveConfigValueSync\b/)).toEqual([
			"coding-agent/src/config/model-registry.ts",
		]);
		expect(await findDefinitions(/function\s+runShellCommand\b/)).toEqual(["coding-agent/src/cli/shell-cli.ts"]);
		expect(await findDefinitions(/function\s+runCommandCaptureStdout\b/)).toEqual([
			"coding-agent/src/config/resolve-config-value.ts",
		]);
		// Per-site scraper and per-linter helpers renamed to carry their source.
		expect(await findDefinitions(/function\s+extractDescription\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+renderComments\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+parseResponse\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+parseSeverity\b/)).toEqual([]);
		// OpenAI-compatible request option guards: one owner shared by the chat
		// and responses server parsers so the accepted value sets never drift.
		expect(await findDefinitions(/function\s+isReasoningEffort\b/)).toEqual([
			"ai/src/providers/openai-request-guards.ts",
		]);
		expect(await findDefinitions(/function\s+isServiceTier\b/)).toEqual([
			"ai/src/providers/openai-request-guards.ts",
		]);
		// Positive-integer flag resolution: one strict owner (validates the
		// fallback too, unlike bench's old copy) in the shared CLI args module.
		expect(await findDefinitions(/function\s+normalizePositiveInteger\b/)).toEqual(["coding-agent/src/cli/args.ts"]);
		// Designed per-binary CLI verbs and token paths pinned as-is.
		expect(await findDefinitions(/function\s+getTokenFilePath\b/)).toEqual([
			"coding-agent/src/cli/auth-broker-cli.ts",
			"coding-agent/src/cli/auth-gateway-cli.ts",
		]);
		expect(await findDefinitions(/function\s+runList\b/)).toEqual([
			"coding-agent/src/cli/auth-broker-cli.ts",
			"coding-agent/src/cli/ttsr-cli.ts",
		]);
		expect(await findDefinitions(/function\s+runBenchRequest\b/)).toEqual([
			"coding-agent/src/cli/bench-cli.ts",
			"coding-agent/src/cli/dry-balance-cli.ts",
		]);
		// Designed per-source discovery loaders pinned as-is (plus the real
		// extensions loader API in extensibility).
		expect(await findDefinitions(/function\s+loadExtensions\b/)).toEqual([
			"coding-agent/src/discovery/builtin.ts",
			"coding-agent/src/discovery/gemini.ts",
			"coding-agent/src/extensibility/extensions/loader.ts",
		]);
		expect(await findDefinitions(/function\s+load\b/)).toEqual([
			"coding-agent/src/discovery/mcp-json.ts",
			"coding-agent/src/discovery/ssh.ts",
		]);
		// Diagnostic display sanitizer and mnemopi bank DB path resolution:
		// hoisted to single exported owners.
		expect(await findDefinitions(/function\s+sanitizeDiagnosticDisplayText\b/)).toEqual([
			"coding-agent/src/tools/render-utils.ts",
		]);
		expect(await findDefinitions(/function\s+resolveBankDbPath\b/)).toEqual(["coding-agent/src/mnemopi/state.ts"]);
		// registerProvider is the capability-registry API; telemetry's local
		// registrar carries its own name.
		expect(await findDefinitions(/function\s+registerProvider\b/)).toEqual(["coding-agent/src/capability/index.ts"]);
		expect(await findDefinitions(/function\s+registerTelemetryProvider\b/)).toEqual([
			"coding-agent/src/telemetry-export.ts",
		]);
		// Designed per-tool renderer pairs (lsp vs task) pinned as-is.
		expect(await findDefinitions(/function\s+renderCall\b/)).toEqual([
			"coding-agent/src/lsp/render.ts",
			"coding-agent/src/task/render.ts",
		]);
		expect(await findDefinitions(/function\s+renderResult\b/)).toEqual([
			"coding-agent/src/lsp/render.ts",
			"coding-agent/src/task/render.ts",
		]);
		// Table-cell padding: plain pad (models-cli) vs truncate-then-pad
		// (sqlite-reader, renamed fitCell) carry distinct names.
		expect(await findDefinitions(/function\s+padCell\b/)).toEqual(["coding-agent/src/cli/models-cli.ts"]);
		expect(await findDefinitions(/function\s+fitCell\b/)).toEqual(["coding-agent/src/tools/sqlite-reader.ts"]);
		// Shared per-binary stdout line writer; config-cli's writeStdout is the
		// distinct backpressure-aware async flush.
		expect(await findDefinitions(/function\s+writeLine\b/)).toEqual(["coding-agent/src/cli/args.ts"]);
		expect(await findDefinitions(/function\s+writeStdout\b/)).toEqual(["coding-agent/src/cli/config-cli.ts"]);
		// promptLine asks on a readline; parsePromptLine classifies a line.
		expect(await findDefinitions(/function\s+promptLine\b/)).toEqual(["coding-agent/src/cli/auth-broker-cli.ts"]);
		expect(await findDefinitions(/function\s+parsePromptLine\b/)).toEqual([
			"coding-agent/src/session/prompt-detection.ts",
		]);
		// Designed per-binary help printers and per-subsystem reset APIs pinned.
		expect(await findDefinitions(/function\s+printHelp\b/)).toEqual([
			"coding-agent/src/cli/args.ts",
			"mnemopi/src/cli.ts",
		]);
		expect(await findDefinitions(/function\s+reset\b/)).toEqual([
			"coding-agent/src/capability/index.ts",
			"coding-agent/src/utils/git.ts",
		]);
		// UI/non-UI same-name pairs: the non-UI side carries a contract-revealing
		// name; the UI (modes/*) side keeps its original name.
		expect(await findDefinitions(/function\s+commandHasPathSegment\b/)).toEqual([
			"coding-agent/src/mcp/transports/stdio.ts",
		]);
		expect(await findDefinitions(/function\s+hasPathSegment\b/)).toEqual([
			"coding-agent/src/modes/components/status-line/component.ts",
		]);
		expect(await findDefinitions(/function\s+normalizeMcpToolArgs\b/)).toEqual([
			"coding-agent/src/mcp/tool-bridge.ts",
		]);
		expect(await findDefinitions(/function\s+normalizeToolArgs\b/)).toEqual([
			"coding-agent/src/modes/utils/transcript-render-helpers.ts",
		]);
		expect(await findDefinitions(/function\s+checkStatusLabel\b/)).toEqual([
			"coding-agent/src/web/scrapers/github.ts",
		]);
		expect(await findDefinitions(/function\s+statusLabel\b/)).toEqual([
			"coding-agent/src/modes/components/tiny-title-download-progress.ts",
		]);
		expect(await findDefinitions(/function\s+renderUsageReportLines\b/)).toEqual([
			"coding-agent/src/slash-commands/helpers/usage-report.ts",
		]);
		expect(await findDefinitions(/function\s+renderUsageReports\b/)).toEqual([
			"coding-agent/src/modes/controllers/command-controller.ts",
		]);
		expect(await findDefinitions(/function\s+resolveGcOptions\b/)).toEqual(["coding-agent/src/cli/gc-cli.ts"]);
		expect(await findDefinitions(/function\s+resolveOptions\b/)).toEqual([
			"coding-agent/src/modes/components/settings-defs.ts",
		]);
		expect(await findDefinitions(/function\s+renderGhJobLine\b/)).toEqual(["coding-agent/src/tools/gh-renderer.ts"]);
		expect(await findDefinitions(/function\s+renderJobLine\b/)).toEqual([
			"coding-agent/src/modes/controllers/command-controller.ts",
		]);
		// Remaining UI/non-UI pairs pinned as-is (distinct contracts per side).
		expect(await findDefinitions(/function\s+optionMarker\b/)).toEqual([
			"coding-agent/src/modes/components/ask-dialog.ts",
			"coding-agent/src/tools/ask.ts",
		]);
		expect(await findDefinitions(/function\s+stripRecommendedSuffix\b/)).toEqual([
			"coding-agent/src/modes/components/ask-dialog.ts",
			"coding-agent/src/tools/ask.ts",
		]);
		expect(await findDefinitions(/function\s+previewLine\b/)).toEqual([
			"coding-agent/src/modes/components/advisor-config.ts",
			"coding-agent/src/tools/render-utils.ts",
		]);
		expect(await findDefinitions(/function\s+readSourceFsPath\b/)).toEqual([
			"coding-agent/src/modes/components/read-tool-group.ts",
			"coding-agent/src/tools/read.ts",
		]);
		expect(await findDefinitions(/function\s+appKey\b/)).toEqual([
			"coding-agent/src/modes/components/keybinding-hints.ts",
			"coding-agent/src/modes/utils/hotkeys-markdown.ts",
		]);
		expect(await findDefinitions(/function\s+previewWork\b/)).toEqual([
			"coding-agent/src/modes/components/background-tan-message.ts",
			"coding-agent/src/modes/controllers/tan-command-controller.ts",
		]);
		// getErrorMessage twins collapsed onto the strengthened pi-utils
		// errorMessage; tavily's payload extractor carries its own name.
		expect(await findDefinitions(/function\s+getErrorMessage\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+extractErrorDetail\b/)).toEqual([
			"coding-agent/src/web/search/providers/tavily.ts",
		]);
		// Version comparison: one prerelease-aware string comparator owner
		// (update-cli's weak dotted-numeric copy and hackage's twin deleted);
		// changelog's struct comparator carries its own name.
		expect(await findDefinitions(/function\s+compareVersions\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+compareSemverLikeVersions\b/)).toEqual([
			"coding-agent/src/utils/version.ts",
		]);
		expect(await findDefinitions(/function\s+compareSemverIdentifier\b/)).toEqual([
			"coding-agent/src/utils/version.ts",
		]);
		expect(await findDefinitions(/function\s+compareChangelogEntryVersions\b/)).toEqual([
			"coding-agent/src/utils/changelog.ts",
		]);
		// mnemopi embedding config: designed layering (config.ts env readers,
		// core/embeddings.ts override-aware resolvers that delegate to them).
		expect(await findDefinitions(/function\s+embeddingApiKey\b/)).toEqual([
			"mnemopi/src/config.ts",
			"mnemopi/src/core/embeddings.ts",
		]);
		expect(await findDefinitions(/function\s+embeddingsDisabled\b/)).toEqual([
			"mnemopi/src/config.ts",
			"mnemopi/src/core/embeddings.ts",
		]);
		// getString twins collapsed onto the widened pi-utils getStringProperty;
		// firstLine wrappers cleaned (vibe inlined onto oneLineLabel, docs-rs
		// renamed to its ellipsizing contract, copy-targets keeps the UI variant).
		expect(await findDefinitions(/function\s+getString\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+firstLine\b/)).toEqual(["coding-agent/src/modes/utils/copy-targets.ts"]);
		expect(await findDefinitions(/function\s+firstLineEllipsized\b/)).toEqual([
			"coding-agent/src/web/scrapers/docs-rs.ts",
		]);
		// Designed pins: per-subsystem config source lists, the SDK system-prompt
		// facade, and the per-provider findApiKey contract.
		expect(await findDefinitions(/function\s+getConfigSources\b/)).toEqual([
			"coding-agent/src/dap/config.ts",
			"coding-agent/src/lsp/config.ts",
		]);
		expect(await findDefinitions(/function\s+buildSystemPrompt\b/)).toEqual([
			"coding-agent/src/sdk.ts",
			"coding-agent/src/system-prompt.ts",
		]);
		expect(await findDefinitions(/function\s+findApiKey\b/)).toEqual([
			"coding-agent/src/exa/mcp-client.ts",
			"coding-agent/src/web/search/providers/brave.ts",
			"coding-agent/src/web/search/providers/jina.ts",
		]);
		// Bounded-concurrency map: one guarded owner (map-phase's copy silently
		// did no work when limit was 0; the owner clamps to 1).
		expect(await findDefinitions(/function\s+runWithConcurrency\b/)).toEqual(["utils/src/async.ts"]);
		// Row readers: generic typed getter (helpers) vs string-coercing rowText
		// (consolidate) carry distinct names.
		expect(await findDefinitions(/function\s+rowValue\b/)).toEqual(["mnemopi/src/core/beam/helpers.ts"]);
		expect(await findDefinitions(/function\s+rowText\b/)).toEqual(["mnemopi/src/core/beam/consolidate.ts"]);
		// Schema ref resolution: full JSON-pointer walker (validator) vs the
		// deliberately defs-only resolver (dereference, renamed).
		expect(await findDefinitions(/function\s+resolveLocalRef\b/)).toEqual([
			"ai/src/utils/schema/json-schema-validator.ts",
		]);
		expect(await findDefinitions(/function\s+resolveDefsRef\b/)).toEqual(["ai/src/utils/schema/dereference.ts"]);
		// startupMarker: cli.ts keeps a documented local copy so the bootstrap
		// import graph stays free of the winston-backed logger module.
		expect(await findDefinitions(/function\s+startupMarker\b/)).toEqual(["utils/src/cli.ts", "utils/src/logger.ts"]);
		// Designed per-backend eval wrappers delegating to backend-helpers.
		expect(await findDefinitions(/function\s+namespaceSessionId\b/)).toEqual([
			"coding-agent/src/eval/backend-helpers.ts",
			"coding-agent/src/eval/jl/index.ts",
			"coding-agent/src/eval/js/index.ts",
			"coding-agent/src/eval/py/index.ts",
			"coding-agent/src/eval/rb/index.ts",
		]);
		expect(await findDefinitions(/function\s+readInterpreterSetting\b/)).toEqual([
			"coding-agent/src/eval/backend-helpers.ts",
			"coding-agent/src/eval/jl/index.ts",
			"coding-agent/src/eval/py/index.ts",
			"coding-agent/src/eval/rb/index.ts",
		]);
		// once is the pi-utils memoizing thunk; the ai schema epoch stamp guard
		// is markEpochOnce.
		expect(await findDefinitions(/function\s+once\b/)).toEqual(["utils/src/abortable.ts"]);
		expect(await findDefinitions(/function\s+markEpochOnce\b/)).toEqual(["ai/src/utils/schema/stamps.ts"]);
		// Per-provider usage payload parsers carry their provider.
		expect(await findDefinitions(/function\s+parseUsagePayload\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+parseKimiUsagePayload\b/)).toEqual(["ai/src/usage/kimi.ts"]);
		expect(await findDefinitions(/function\s+parseCodexUsagePayload\b/)).toEqual(["ai/src/usage/openai-codex.ts"]);
		// Model -> ModelSpec projection: one owner (the registry's local copy
		// leaked the raw compatConfig field into its output).
		expect(await findDefinitions(/function\s+toModelSpec\b/)).toEqual([
			"catalog/src/provider-models/bundled-references.ts",
		]);
		// Frontmatter key normalization vs KeyId list coercion/dedup.
		expect(await findDefinitions(/function\s+normalizeKeys\b/)).toEqual(["utils/src/frontmatter.ts"]);
		expect(await findDefinitions(/function\s+normalizeKeyIds\b/)).toEqual(["tui/src/keybindings.ts"]);
		// Designed legacy-shim facade over the utils frontmatter parser.
		expect(await findDefinitions(/function\s+parseFrontmatter\b/)).toEqual([
			"coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
			"utils/src/frontmatter.ts",
		]);
		// mnemopi LLM config: env readers (config.ts) + override-aware resolvers
		// (core/local-llm.ts); extraction.ts's raw env-reader twins collapsed
		// onto config.ts.
		expect(await findDefinitions(/function\s+llmEnabled\b/)).toEqual([
			"mnemopi/src/config.ts",
			"mnemopi/src/core/local-llm.ts",
		]);
		expect(await findDefinitions(/function\s+hostLlmEnabled\b/)).toEqual([
			"mnemopi/src/config.ts",
			"mnemopi/src/core/local-llm.ts",
		]);
		expect(await findDefinitions(/function\s+llmMaxTokens\b/)).toEqual([
			"mnemopi/src/config.ts",
			"mnemopi/src/core/local-llm.ts",
		]);
		expect(await findDefinitions(/function\s+llmApiKey\b/)).toEqual([
			"mnemopi/src/config.ts",
			"mnemopi/src/core/local-llm.ts",
		]);
		expect(await findDefinitions(/function\s+llmBaseUrl\b/)).toEqual([
			"mnemopi/src/config.ts",
			"mnemopi/src/core/local-llm.ts",
		]);
		// Designed auth-broker layering (ai owner + coding-agent wrappers) and
		// per-subsystem slash-command verbs.
		expect(await findDefinitions(/function\s+resolveAuthBrokerConfig\b/)).toEqual([
			"ai/src/auth-broker/discover.ts",
			"coding-agent/src/session/auth-broker-config.ts",
		]);
		expect(await findDefinitions(/function\s+discoverAuthStorage\b/)).toEqual([
			"ai/src/auth-broker/discover.ts",
			"coding-agent/src/sdk.ts",
			"coding-agent/src/session/auth-broker-config.ts",
		]);
		expect(await findDefinitions(/function\s+handleRemoveCommand\b/)).toEqual([
			"coding-agent/src/slash-commands/helpers/mcp.ts",
			"coding-agent/src/slash-commands/helpers/ssh.ts",
		]);
		// formatProviderName: usage-report owns it; the modes copy is UI-lane
		// (pending its owner) and pinned here so no third copy appears.
		expect(await findDefinitions(/function\s+formatProviderName\b/)).toEqual([
			"coding-agent/src/modes/controllers/command-controller.ts",
			"coding-agent/src/slash-commands/helpers/usage-report.ts",
		]);
		// normalizePremiumRequests: pi-utils owns it; the status-line copy is
		// UI-lane and pinned pending its owner.
		expect(await findDefinitions(/function\s+normalizePremiumRequests\b/)).toEqual([
			"coding-agent/src/modes/components/status-line/segments.ts",
			"utils/src/format.ts",
		]);
		// Designed per-transport error reconstruction and per-site author formats.
		expect(await findDefinitions(/function\s+errorFromPayload\b/)).toEqual([
			"coding-agent/src/eval/js/context-manager.ts",
			"coding-agent/src/eval/js/worker-core.ts",
			"coding-agent/src/tools/browser/tab-supervisor.ts",
		]);
		expect(await findDefinitions(/function\s+formatAuthor\b/)).toEqual([
			"coding-agent/src/tools/gh.ts",
			"coding-agent/src/web/scrapers/discourse.ts",
			"coding-agent/src/web/scrapers/lemmy.ts",
		]);
		// Designed per-binary CLI verb pairs and entry points.
		expect(await findDefinitions(/function\s+runServe\b/)).toEqual([
			"coding-agent/src/cli/auth-broker-cli.ts",
			"coding-agent/src/cli/auth-gateway-cli.ts",
		]);
		expect(await findDefinitions(/function\s+runStatus\b/)).toEqual([
			"coding-agent/src/cli/auth-broker-cli.ts",
			"coding-agent/src/cli/auth-gateway-cli.ts",
		]);
		expect(await findDefinitions(/function\s+runToken\b/)).toEqual([
			"coding-agent/src/cli/auth-broker-cli.ts",
			"coding-agent/src/cli/auth-gateway-cli.ts",
		]);
		expect(await findDefinitions(/function\s+runCli\b/)).toEqual(["coding-agent/src/cli.ts", "mnemopi/src/cli.ts"]);
		// Designed per-VCS command runners (git vs jj).
		expect(await findDefinitions(/function\s+runChecked\b/)).toEqual([
			"coding-agent/src/utils/git.ts",
			"coding-agent/src/utils/jj.ts",
		]);
		expect(await findDefinitions(/function\s+runText\b/)).toEqual([
			"coding-agent/src/utils/git.ts",
			"coding-agent/src/utils/jj.ts",
		]);
		// Designed stats layering: aggregator computes, client/api fetches.
		expect(await findDefinitions(/function\s+getOverviewStats\b/)).toEqual([
			"stats/src/aggregator.ts",
			"stats/src/client/api.ts",
		]);
		expect(await findDefinitions(/function\s+getRequestDetails\b/)).toEqual([
			"stats/src/aggregator.ts",
			"stats/src/client/api.ts",
		]);
		expect(await findDefinitions(/function\s+getBehaviorDashboardStats\b/)).toEqual([
			"stats/src/aggregator.ts",
			"stats/src/client/api.ts",
		]);
		expect(await findDefinitions(/function\s+getCostDashboardStats\b/)).toEqual([
			"stats/src/aggregator.ts",
			"stats/src/client/api.ts",
		]);
		expect(await findDefinitions(/function\s+getModelDashboardStats\b/)).toEqual([
			"stats/src/aggregator.ts",
			"stats/src/client/api.ts",
		]);
		expect(await findDefinitions(/function\s+getGainDashboardStats\b/)).toEqual([
			"stats/src/client/api.ts",
			"stats/src/gain-aggregator.ts",
		]);
		// Designed mnemopi facade: memory.ts fronts the beam store/consolidate owners.
		expect(await findDefinitions(/function\s+remember\b/)).toEqual([
			"mnemopi/src/core/beam/store.ts",
			"mnemopi/src/core/memory.ts",
		]);
		expect(await findDefinitions(/function\s+getContext\b/)).toEqual([
			"mnemopi/src/core/beam/store.ts",
			"mnemopi/src/core/memory.ts",
		]);
		expect(await findDefinitions(/function\s+scratchpadRead\b/)).toEqual([
			"mnemopi/src/core/beam/store.ts",
			"mnemopi/src/core/memory.ts",
		]);
		expect(await findDefinitions(/function\s+scratchpadWrite\b/)).toEqual([
			"mnemopi/src/core/beam/store.ts",
			"mnemopi/src/core/memory.ts",
		]);
		expect(await findDefinitions(/function\s+scratchpadClear\b/)).toEqual([
			"mnemopi/src/core/beam/store.ts",
			"mnemopi/src/core/memory.ts",
		]);
		// Designed per-provider usage amount builders.
		expect(await findDefinitions(/function\s+buildAmount\b/)).toEqual([
			"ai/src/usage/gemini.ts",
			"ai/src/usage/github-copilot.ts",
			"ai/src/usage/google-antigravity.ts",
		]);
		// utils/src/color.ts is the only editable owner of the color helpers.
		expect(await findDefinitions(/function\s+hexToRgb\b/)).toEqual(["utils/src/color.ts"]);
		expect(await findDefinitions(/function\s+rgbToHex\b/)).toEqual(["utils/src/color.ts"]);
		expect(await findDefinitions(/function\s+hslToHex\b/)).toEqual(["utils/src/color.ts"]);
		// delay was a pointless wrapper over Bun.sleep — inlined away.
		expect(await findDefinitions(/function\s+delay\b/)).toEqual([]);
		// lineCount: session-history-format is the single owner.
		expect(await findDefinitions(/function\s+lineCount\b/)).toEqual([
			"coding-agent/src/session/session-history-format.ts",
		]);
		// Designed legacy-shim facade over the SDK createAgentSession.
		expect(await findDefinitions(/function\s+createAgentSession\b/)).toEqual([
			"coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
			"coding-agent/src/sdk.ts",
		]);
		expect(await findDefinitions(/function\s+detectColorMode\b/)).toEqual(["coding-agent/src/modes/theme/color.ts"]);

		// veracity vocabulary: one owner in mnemopi's veracity-consolidation.ts;
		// the store/recall/consolidate twins (clampStoredVeracity, the local
		// VERACITY_WEIGHTS table, EPISODIC_VERACITY_WEIGHT) were collapsed onto it.
		expect(await findDefinitions(/function\s+clampVeracity\b/)).toEqual([
			"mnemopi/src/core/veracity-consolidation.ts",
		]);
		expect(await findDefinitions(/function\s+isVeracity\b/)).toEqual(["mnemopi/src/core/veracity-consolidation.ts"]);
		expect(await findDefinitions(/const VERACITY_WEIGHTS\b/)).toEqual(["mnemopi/src/core/veracity-consolidation.ts"]);
		expect(await findDefinitions(/function\s+clampStoredVeracity\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+clampEpisodicVeracity\b/)).toEqual([]);
		expect(await findDefinitions(/EPISODIC_VERACITY_WEIGHT\b/)).toEqual([]);
	}, 60_000);

	it("CLI entry-point names stay limited to the documented per-binary set", async () => {
		expect(await findDefinitions(/function\s+main\b/)).toEqual([
			"coding-agent/src/main.ts",
			"metaharness/src/runner.ts",
			"mnemopi/src/mcp-server.ts",
			"stats/src/index.ts",
		]);
		expect(await findDefinitions(/function\s+runCli\b/)).toEqual(["coding-agent/src/cli.ts", "mnemopi/src/cli.ts"]);
		expect(await findDefinitions(/function\s+printHelp\b/)).toEqual([
			"coding-agent/src/cli/args.ts",
			"mnemopi/src/cli.ts",
		]);
		expect(await findDefinitions(/function\s+escapeRegexLiteral\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+escapeRegExp\b/)).toEqual(["utils/src/regex.ts"]);
		expect(await findDefinitions(/function\s+expandTilde\b/)).toEqual(["utils/src/path.ts"]);
		// Async existence checks import utils pathExists; the sync variant is named for it.
		expect(await findDefinitions(/function\s+fileExists\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+fileExistsSync\b/)).toEqual(["coding-agent/src/tools/path-utils.ts"]);
		expect(await findDefinitions(/function\s+extractMessageText\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+nonBlankMessageText\b/)).toEqual([
			"coding-agent/src/commit/agentic/agent.ts",
		]);
		expect(await findDefinitions(/function\s+messageTextWithToolCalls\b/)).toEqual([
			"coding-agent/src/memories/index.ts",
		]);
		// acp's duck-typed property probe vs session-listing's raw-JSON scanner.
		expect(await findDefinitions(/function\s+extractStringProperty\b/)).toEqual([
			"coding-agent/src/modes/acp/acp-event-mapper.ts",
		]);
		expect(await findDefinitions(/function\s+scanJsonStringProperty\b/)).toEqual([
			"coding-agent/src/session/session-listing.ts",
		]);
		expect(await findDefinitions(/function\s+atomicWriteJson\b/)).toEqual(["utils/src/atomic-write.ts"]);
		expect(await findDefinitions(/function\s+utf8ByteLength\b/)).toEqual(["utils/src/binary.ts"]);
		expect(await findDefinitions(/function\s+byteLength\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+decodeStrictUtf8\b/)).toEqual(["utils/src/binary.ts"]);
		// Divergent pre-decode guards kept at their call sites, delegating to the
		// strict decoder: read sniffs binary headers, ssh rejects NUL bytes.
		expect(await findDefinitions(/function\s+decodeUtf8Text\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+decodeNonBinaryUtf8\b/)).toEqual(["coding-agent/src/tools/read.ts"]);
		expect(await findDefinitions(/function\s+decodeNulFreeUtf8\b/)).toEqual([
			"coding-agent/src/internal-urls/ssh-protocol.ts",
		]);
		expect(await findDefinitions(/function\s+resolvePath\b/)).toEqual([
			// The exported expand-tilde + local://-guard contract; capability/fs's
			// trivial wrapper was inlined, js-helpers' ctx-cwd variant renamed.
			"coding-agent/src/extensibility/utils.ts",
		]);
		expect(await findDefinitions(/function\s+resolveHelperPath\b/)).toEqual([
			"coding-agent/src/eval/js/shared/helpers.ts",
		]);
		expect(await findDefinitions(/function\s+resolveCwdPath\b/)).toEqual([
			"coding-agent/src/eval/js/shared/helpers.ts",
		]);
		expect(await findDefinitions(/function\s+loadModel\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+loadTtsModel\b/)).toEqual(["coding-agent/src/tts/tts-worker.ts"]);
		expect(await findDefinitions(/function\s+loadAsrModel\b/)).toEqual(["coding-agent/src/stt/asr-worker.ts"]);
		expect(await findDefinitions(/function\s+loadEmbedModel\b/)).toEqual([
			"coding-agent/src/mnemopi/embed-worker.ts",
		]);
		// Designed per-source discovery loaders, same family as loadExtensions.
		expect(await findDefinitions(/function\s+loadSystemPrompt\b/)).toEqual([
			"coding-agent/src/discovery/agents.ts",
			"coding-agent/src/discovery/builtin.ts",
			"coding-agent/src/discovery/gemini.ts",
		]);
		// Live temporal scoring lives in beam/recall; the helpers.ts and
		// util/datetime.ts triplicates had zero production consumers (deleted).
		expect(await findDefinitions(/function\s+temporalBoost\b/)).toEqual(["mnemopi/src/core/beam/recall.ts"]);
		expect(await findDefinitions(/function\s+recencyDecay\b/)).toEqual(["mnemopi/src/core/beam/recall.ts"]);
		// recall's parseQueryTime is lenient (normalizes bare dates to UTC);
		// datetime's strict variant throws on invalid input.
		expect(await findDefinitions(/function\s+parseQueryTime\b/)).toEqual(["mnemopi/src/core/beam/recall.ts"]);
		expect(await findDefinitions(/function\s+parseQueryTimeStrict\b/)).toEqual(["mnemopi/src/util/datetime.ts"]);
		expect(await findDefinitions(/function\s+parseIsoDateTimeUtc\b/)).toEqual(["mnemopi/src/util/datetime.ts"]);
		// Legacy shim keeps the loose Reflect.get stringField (pairs with its
		// numberField); the other variants were renamed to their contracts.
		expect(await findDefinitions(/function\s+stringField\b/)).toEqual([
			"coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
		]);
		expect(await findDefinitions(/function\s+nonEmptyStringField\b/)).toEqual([
			"coding-agent/src/extensibility/tool-event-input.ts",
		]);
		expect(await findDefinitions(/function\s+trimmedStringField\b/)).toEqual([
			"coding-agent/src/modes/controllers/omfg-rule.ts",
		]);
		expect(await findDefinitions(/function\s+textResult\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+vibeTextResult\b/)).toEqual(["coding-agent/src/tools/vibe.ts"]);
		expect(await findDefinitions(/function\s+galleryTextResult\b/)).toEqual([
			"coding-agent/src/cli/gallery-fixtures/fs.ts",
		]);
		expect(await findDefinitions(/function\s+firstTextBlockText\b/)).toEqual([
			"coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
		]);
		// tool-errors owns abort-guarding (preserves signal.reason as cause);
		// kernel-base's rethrow-the-reason variant is a different contract.
		expect(await findDefinitions(/function\s+throwIfAborted\b/)).toEqual(["coding-agent/src/tools/tool-errors.ts"]);
		expect(await findDefinitions(/function\s+throwIfKernelAborted\b/)).toEqual([
			"coding-agent/src/eval/kernel-base.ts",
		]);
		expect(await findDefinitions(/function\s+pathExists\b/)).toEqual(["utils/src/fs-error.ts"]);
		// gc-cli's variant fails closed: only ENOENT is "missing"; other stat errors throw.
		expect(await findDefinitions(/function\s+pathExistsStrict\b/)).toEqual(["coding-agent/src/cli/gc-cli.ts"]);
		expect(await findDefinitions(/function\s+logWorkerMessage\b/)).toEqual([
			"coding-agent/src/subprocess/worker-client.ts",
		]);
		expect(await findDefinitions(/function\s+requireRemainingTimeoutMs\b/)).toEqual([
			"coding-agent/src/eval/executor-base.ts",
		]);
		// safeSend owns thenable-aware subprocess sends; the state-guarded worker
		// variants were renamed to their transports.
		expect(await findDefinitions(/function\s+safeSend\b/)).toEqual(["coding-agent/src/utils/ipc.ts"]);
		expect(await findDefinitions(/function\s+sendToTabWorker\b/)).toEqual([
			"coding-agent/src/tools/browser/tab-supervisor.ts",
		]);
		expect(await findDefinitions(/function\s+sendToJsWorker\b/)).toEqual([
			"coding-agent/src/eval/js/context-manager.ts",
		]);
		expect(await findDefinitions(/function\s+buildRequestBody\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+buildUsageAmount\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+percentUsageAmount\b/)).toEqual(["ai/src/usage.ts"]);
		expect(await findDefinitions(/function\s+kimiRowUsageAmount\b/)).toEqual(["ai/src/usage/kimi.ts"]);
		expect(await findDefinitions(/function\s+zaiUsageAmount\b/)).toEqual(["ai/src/usage/zai.ts"]);
		expect(await findDefinitions(/function\s+windowUsageAmount\b/)).toEqual(["ai/src/usage/openai-codex.ts"]);
		expect(await findDefinitions(/function\s+buildSessionKey\b/)).toEqual([]);
		// NUL-separated kernel-session key owner; jl's drifted "::" variant was a
		// latent collision (paths can contain "::", never NUL).
		expect(await findDefinitions(/function\s+interpreterSessionKey\b/)).toEqual([
			"coding-agent/src/eval/executor-base.ts",
		]);
		expect(await findDefinitions(/function\s+normalizeSessionCwd\b/)).toEqual([
			"coding-agent/src/eval/executor-base.ts",
		]);
		expect(await findDefinitions(/function\s+buildBashSessionKey\b/)).toEqual([
			"coding-agent/src/exec/bash-executor.ts",
		]);
		// Designed per-language kernel plumbing: each executor resolves its own
		// runtime and owns its session map; same contract, per-language impls.
		expect(await findDefinitions(/function\s+normalizeExplicitInterpreter\b/)).toEqual([
			"coding-agent/src/eval/jl/executor.ts",
			"coding-agent/src/eval/py/executor.ts",
			"coding-agent/src/eval/rb/executor.ts",
		]);
		expect(await findDefinitions(/function\s+acquireSession\b/)).toEqual([
			"coding-agent/src/eval/jl/executor.ts",
			"coding-agent/src/eval/js/context-manager.ts",
			"coding-agent/src/eval/py/executor.ts",
			"coding-agent/src/eval/rb/executor.ts",
		]);
		expect(await findDefinitions(/function\s+fetchJson\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+fetchJsonOrThrow\b/)).toEqual(["ai/src/utils/fetch-json.ts"]);
		// Divergent JSON fetchers renamed to their contracts: dashboard client
		// throws ApiError; the MusicBrainz scraper returns null via loadPage.
		expect(await findDefinitions(/function\s+fetchDashboardJson\b/)).toEqual(["stats/src/client/api.ts"]);
		expect(await findDefinitions(/function\s+fetchMusicBrainzJson\b/)).toEqual([
			"coding-agent/src/web/scrapers/musicbrainz.ts",
		]);
		expect(await findDefinitions(/function\s+normalizeText\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+collapseWhitespace\b/)).toEqual(["utils/src/lines.ts"]);
		expect(await findDefinitions(/function\s+clampAcpText\b/)).toEqual([
			"coding-agent/src/modes/acp/acp-event-mapper.ts",
		]);
		expect(await findDefinitions(/function\s+normalizeGhText\b/)).toEqual(["coding-agent/src/tools/gh.ts"]);
		expect(await findDefinitions(/function\s+getContentType\b/)).toEqual([]);
		// One extension->MIME owner for every file-backed internal-urls protocol
		// (skill:// and memory:// previously drifted: .json served as text/plain).
		expect(await findDefinitions(/function\s+contentTypeForFileExtension\b/)).toEqual([
			"coding-agent/src/internal-urls/filesystem-resource.ts",
		]);
		expect(await findDefinitions(/function\s+contentBlockType\b/)).toEqual([
			"coding-agent/src/modes/acp/acp-event-mapper.ts",
		]);
		expect(await findDefinitions(/function\s+classifySpotifyUrl\b/)).toEqual([
			"coding-agent/src/web/scrapers/spotify.ts",
		]);
		expect(await findDefinitions(/function\s+wrapSubprocess\b/)).toEqual([
			// Sole remaining def: embed-client's variant deliberately lets proc.send
			// throw (a swallowed send would hang the pending resolver). The
			// stt/tts/tiny-title triplets were replaced by worker-client's
			// createRefCountedWorkerHandle / createUnavailableRefCountedWorker.
			"coding-agent/src/mnemopi/embed-client.ts",
		]);
		expect(await findDefinitions(/function\s+createRefCountedWorkerHandle\b/)).toEqual([
			"coding-agent/src/subprocess/worker-client.ts",
		]);
		expect(await findDefinitions(/function\s+createUnavailableRefCountedWorker\b/)).toEqual([
			"coding-agent/src/subprocess/worker-client.ts",
		]);
		expect(await findDefinitions(/function\s+spawnInlineUnavailableWorker\b/)).toEqual([]);
		expect(await findDefinitions(/function\s+usage\b/)).toEqual([
			// The two .test.ts entries are test-local fixture factories that live under src/.
			"coding-agent/src/eval/__tests__/budget-bridge.test.ts",
			"coding-agent/src/modes/utils/transcript-render-helpers.test.ts",
			"coding-agent/src/slash-commands/helpers/parse.ts",
			"mnemopi/src/cli.ts",
		]);
	});
});

describe("estimateTextTokens", () => {
	it("rounds UTF-8 bytes up to a 4-byte token", () => {
		expect(estimateTextTokens("")).toBe(0);
		expect(estimateTextTokens("abcd")).toBe(1);
		expect(estimateTextTokens("abcde")).toBe(2);
		// 3-byte CJK chars: 4 chars = 12 bytes = 3 tokens (char/4 would say 1)
		expect(estimateTextTokens("\u65e5\u672c\u8a9e\u6f22")).toBe(3);
	});
});
