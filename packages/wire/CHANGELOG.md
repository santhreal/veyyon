# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `RECOMMENDED_SUFFIX`, `withRecommendedSuffix` and `stripRecommendedSuffix` own the ` (Recommended)` marker the ask dialog puts on the recommended option. The marker had four private spellings and two of them were writers: `tools/ask.ts` and `modes/components/ask-dialog.ts` both appended it, the second from a bare template literal, and `@veyyon/tool-render` stripped it with a third copy. A reader that stops matching the writer does not throw; the marker survives into the answer, so the model is told the user chose "Deploy to production (Recommended)". The marker lives here rather than beside the other ask labels because tool-render has to read it and cannot import from coding-agent.
- `sealBytes` and `openBytes` expose the sealed envelope itself, `[12B random IV][AES-256-GCM ciphertext with its tag]`, for payloads that are not JSON. `sealFrame` and `openFrame` are now the JSON layer on top of them rather than a second writer of the same bytes. Session sharing gzips before it seals, so it could not use `sealFrame` and had hand-written the envelope a second time with its own copy of the IV length; that copy is read by a browser from an already-published link, so a drift between the two halves would have surfaced as a link that no longer opens, after the session was gone from the machine that sealed it.
- `TODO_STATUS_IS_TERMINAL` owns the todo status vocabulary and the one question every renderer asks of it: has the task closed? `TodoStatus` derives from its keys, `TODO_STATUSES` enumerates them at run time, and `isTerminalTodoStatus`, `asTodoStatus`, `isTodoListDone` and `TODO_DONE_SUMMARY` sit alongside it. A todo board is drawn on both sides of a runtime boundary — the TUI in `@veyyon/coding-agent` and the HTML/collab renderer in `@veyyon/tool-render`, which cannot import from it — and each held a private copy of the vocabulary, so the two could disagree about whether a plan had finished. Adding a status now forces a terminality decision at the definition and breaks every `Record<TodoStatus, …>` table until it is answered.
- `auto_retry_start` and `auto_retry_end` carry an optional `mode` naming which recovery is waiting: absent means a retry, and `continue` means a tool batch the host cannot resend is being carried forward instead. A guest renders the countdown from these events, so without the field it had no way to avoid calling a continuation a retry. Spelled as a literal union rather than imported, because this package depends on nothing.
- `stripTaskResultEnvelope` owns the `<task-result>` envelope a finished subagent returns, so a job row previews the answer instead of the markup around it. The envelope is written by the task-summary prompt and addressed to the model: status, duration, an `agent://` pointer, and the body inside `<output>` or `<preview>`. Both surfaces that draw job rows stripped it with a byte-identical private copy of the pattern, one in the TUI job tool and one in the HTML/collab renderer, which cannot import from it. Two readers of one wire shape drift in a single direction: the surface nobody is watching keeps the old pattern, stops matching, and shows raw markup where the other shows the answer.

### Fixed

- `asTodoStatus` no longer accepts a prototype key as a status. It tested membership with `in`, which walks the prototype chain, so a transcript carrying `status: "toString"` narrowed to that string and then read as TERMINAL, because `TODO_STATUS_IS_TERMINAL["toString"]` resolves to `Object.prototype.toString`. A board with open work collapsed to "Todo list done". Membership is now `Object.hasOwn` and terminality compares `=== true`.

## [16.3.0] - 2026-07-02

### Breaking Changes

- Upgraded the collaboration protocol to version 3. Guests using version 2 will now be rejected during the handshake with a protocol-mismatch error.

### Added

- Added support for interactive UI request and response frames, enabling browser guests to respond to prompts initiated by the host.

## [16.1.8] - 2026-06-20

### Breaking Changes

- Bumped `COLLAB_PROTO` to `2`. The `welcome` host frame now carries metadata only (`header`, `state`, `agents`, `entryCount`, optional `readOnly`) — the transcript moves to a new `snapshot-chunk` host frame (`{ entries: SessionEntry[]; final: boolean }`) sent immediately after the welcome. Hosts split large snapshots into multiple chunks; the last chunk carries `final: true`. Old guests speaking proto v1 are rejected with the existing protocol-mismatch error. ([#3144](https://github.com/can1357/oh-my-pi/issues/3144))

## [15.12.4] - 2026-06-13

### Changed

- Changed `WireModel.contextWindow` and `ContextUsage.contextWindow` to `number | null` to allow representing unavailable context-window values

## [15.12.0] - 2026-06-12

### Added

- Added `readOnly` flags to participant and session payload types to indicate when a guest is connected via a read-only (view) link
- Added `writeToken` to `GuestFrame` hello payloads and parsed collaboration links so full-access links can carry and expose a write-capability token
- Added `ROOM_KEY_BYTES` and `WRITE_TOKEN_BYTES` constants for room key and write-token sizing in the wire protocol
- Added `DEFAULT_SHARE_URL` (`https://my.omp.sh/s`), the default share viewer/upload base for `/share` links

## [15.11.8] - 2026-06-12

### Added

- Added shared collab live-session wire contracts for the host CLI and browser guest client.

## [1.0.38] - 2026-07-31

### Added

- `src/relay.ts` owns the collab relay protocol: the control-message types that used to sit at the bottom of `index.ts`, the fatal close-code table, the `isRelayFatalCloseCode` / `relayFatalCloseReason` predicates, and the client-side reconnect send bound. Three programs speak this protocol, the relay and two independent clients, and each client carried its own copy of the table character for character, doc comment included, plus its own `MAX_PENDING_SENDS = 256`. A code the table does not list is TRANSIENT, so a client retries: add a fatal code to the relay, teach one client, and the other reconnects in a loop against a condition that will never clear, backing off to thirty seconds and staying there without throwing or logging an error. The module has no imports, so a client pays one module for the protocol rather than the 900-line message barrel it sits beside, which is why the constants were copied instead of imported before. `index.ts` re-exports everything, so anything that already took the relay types from `@veyyon/wire` is unchanged.
- The seven custom message roles are now declared: `WireBashExecutionMessage`,
  `WirePythonExecutionMessage`, `WireCustomMessage`, `WireHookMessage`, `WireBranchSummaryMessage`,
  `WireCompactionSummaryMessage` and `WireFileMentionMessage`. `WireMessage` is the union of all
  eleven.

  A session message can carry eleven roles and this package declared four. The other seven come from
  the host's `CustomAgentMessages` hook, and a guest renders every one of them, because its replica
  transcript is drawn by the same renderer the host uses. So they always travelled, and they
  travelled undeclared: nothing stated what a guest receives for a `!ls`, and any field added to one
  of them would have shipped the day it was added.

  Two shapes lost fields in the process. `attribution` comes off `custom` and `hookMessage`: it
  records who to bill for the turn, which is host bookkeeping. `providerPayload` comes off
  `compactionSummary`, along with two legacy image-archive block arrays: it is the transport-native
  history used to replay the compacted span upstream, it is large, and nothing draws it.

  `WireFileMentionMessage` also lost the file bodies. A `@path` mention persists each mentioned
  file's full text in `content`, and the renderer draws none of it: a row shows the path, the line
  count or the skip reason, and whether an image came with it. So mentioning a 4 MB file sent 4 MB to
  every guest, on the join snapshot and again on the entry frame, and landed it in their replica
  session file on disk. `hasContent: boolean` replaces it, because absence has to stay
  distinguishable from emptiness: a guest exporting its replica now says the body was not replicated
  instead of printing an empty `<file>` block as though it had read one.

  `details` on the two extension roles and `meta` on the two execution roles stay `unknown` by
  contract, on the same terms as a tool result's `details`: the host package's own formatter and the
  extension's own renderer own those shapes, and narrowing them here would mean copying host types
  into a published contract and keeping them in step by hand.
- `WireModel` now declares `reasoning` and a narrowed `thinking` config (`mode`, `efforts`,
  `defaultLevel`).

  A guest's status line shows a thinking level, and the level picker offers the efforts the model
  actually has. Both read the model, so the four-field `WireModel` was too narrow to draw the footer
  the guest already draws. The parts of the host's `ThinkingConfig` left out (`effortMap`,
  `effortRouting`, the per-effort token budgets, `supportsDisplay`) all encode an effort into a
  provider wire field, which is request shaping and never happens on a guest.
- `WireAssistantMessage` now declares `provider`, the bare id of what answered (`"anthropic"`).

  It is required rather than optional, which is a breaking change for anyone constructing one by
  hand. That is deliberate: a guest holds a transcript replica, and a replica that cannot say what
  answered is not faithful. The host has always had the value, and until now it reached guests only
  as part of the leak described below, which meant it was present in practice and absent from the
  contract. The host's `api` stays undeclared: that is the transport endpoint the request went to,
  which is a detail of how the host happens to be configured, and no guest draws it.
- `sealFrame`, `openFrame`, `SEAL_IV_BYTES`, `generateRoomKey`, `generateWriteToken` and
  `importRoomKey`: the AES-256-GCM frame seal (`[12B IV][ciphertext+tag]`), which the host and the
  browser guest had each implemented in full. The layout is a wire format like everything else here,
  and its drift failure is the worst kind available: a GCM tag mismatch cannot distinguish a wrong
  key from a wrong layout, so changing the IV length on one side presents as every frame failing to
  authenticate with nothing naming the cause. Both sides now bind only their own frame type. Nothing
  added here reaches for Node, so the browser guest still imports this package directly.
- `importRoomKey` reports a wrong key length as a rejection instead of a synchronous throw. It
  returned a promise but threw that one error synchronously, and the browser client hands the promise
  to its socket without awaiting it, so a mangled link threw out of the socket's construction rather
  than reaching the connection's error path.
- `packEnvelope`, `unpackEnvelope`, and `rewriteEnvelopePeer`: the codec for the plaintext collab
  envelope (`[4B uint32 BE peerId][sealed payload]`), now beside the `ENVELOPE_HEADER_LENGTH` they read.
  The TUI host and the browser guest each carried a byte-identical copy, so one wire format had two
  statements of its byte order and header width. That drift is silent by construction: the payload still
  decrypts, because the room key is untouched, so the only symptom is a frame arriving at the wrong peer,
  or broadcast to a room that should not have seen it. Nothing in the package needs Node, so the browser
  guest imports it directly. No wire-format change.
- `WELCOME_TIMEOUT_MS`, `SNAPSHOT_PROGRESS_TIMEOUT_MS`, and `TRANSCRIPT_TIMEOUT_MS`: the budgets a collab
  guest allows the host for each of its three round trips. These describe the protocol, so they now live
  beside the envelope and link constants instead of being declared separately by each guest. Both guests
  import them; see the Fixed note below for why that matters.
- `FallbackContent` is now part of `AssistantContent`. An Anthropic server-side-fallback marker
  (`{ type: "fallback", from, to }`) was already reaching guests on assistant turns whose request opted
  into provider fallbacks; the union simply did not admit it, so a client with an exhaustive `switch`
  had no reason to handle a block it was told could not exist. Renderers should ignore it: it marks a
  model hand-off and carries no content. No wire-format change.

### Changed

- The `state` frame's model is now PROJECTED, and this one was deliberate, which is what makes it
  worth reading rather than a fourth repeat.

  The host-side `CollabSessionState.model` was typed as the full catalog `Model` on purpose, so a
  guest could apply the host's real model to its replica and get native display instead of a display
  string. The intent was right and the type was wrong: `WireModel` declared four fields, so the
  contract and the value disagreed the same way they did in the three doors below.

  What actually travelled was `baseUrl`, the endpoint the host talks to, which on a proxied,
  self-hosted or gateway-routed configuration is an internal host. The `state` frame is debounced
  and repeated: it re-broadcasts every couple of seconds for the whole length of a stream, to every
  guest, including read-only viewers. The per-million pricing table, `requestModelId`, `headers` and
  the compatibility record rode along on the same object.

  The rule the projection encodes is structural, not a field-by-field judgement: a guest never
  builds a provider request, because it renders a replica and forwards prompts to the host. So every
  field whose only job is to shape a request is absent on principle. On the receiving side the host
  package widens the wire model back into a `Model` with inert values rather than plausible ones:
  the endpoint becomes `collab-guest://no-provider-endpoint`, and zero pricing is marked `"unknown"`
  so nothing reads the zeros as free.
- Live events are now PROJECTED by the host too, and this was the widest of the three doors.

  `agent_end` is declared here as `{ type: "agent_end" }` with no payload. The host's own
  `agent_end` carries `messages`, the entire message array of the run, so the whole conversation
  went out one more time at the end of every run, every provider payload inside it included.
  `turn_end` declares nothing and carried the turn's message plus every tool result. The three
  message arms carried a full host assistant message, and `message_update` fires once per streaming
  delta, which makes it the highest-frequency frame in the protocol.

  The message arms share the same projection transcript entries use, so an entry and an event
  cannot disagree about what a guest receives for the same assistant turn.

  The `tool_execution_*` arms are unchanged and pass their payloads through. That is the contract
  rather than an oversight: `args`, `partialResult` and `result` are declared `unknown` because a
  tool's arguments and result are the tool's own shape, and a guest renders them by asking the tool
  how.
- Transcript entries are now PROJECTED by the host before they are sent, not filtered by type and
  passed through. This closes the same defect the `welcome` header had one frame over.

  The host used to narrow entries with a type guard and broadcast them verbatim. A type guard
  narrows the type and leaves the value alone, so every field a host entry carried beyond what this
  package declares travelled with it, and a guest writes what it receives into its own replica
  session file. On an assistant turn that meant `providerPayload` (the transport-native history used
  to replay a turn upstream), `request` (the sampling parameters exactly as sent),
  `contextSnapshot`, `retryRecovery`, `turnMetrics` and ten more; on tool results `prunedAt`,
  `useless` and `metrics`; on user turns `steering` and `attribution`.

  Nothing in this package changed to cause it and nothing here could have caught it, which is the
  point of writing it down: `WireSessionEntry` described what a guest receives, and description is
  not enforcement. The host now builds each entry field by field, and its frame types name the wire
  entry rather than its own, so the compiler asks for the projection.
- The message vocabulary is prefixed to match: `UserMessage`, `DeveloperMessage`,
  `AssistantMessage`, `ToolResultMessage` and `StopReason` are now `WireUserMessage`,
  `WireDeveloperMessage`, `WireAssistantMessage`, `WireToolResultMessage` and `WireStopReason`.
  Each old name is kept as a renamed export, so existing imports keep working.

  Every one of them was also declared in `@veyyon/ai`, wider. The host's assistant turn carries
  provider payloads, the sampling parameters a turn was sent with, retry records and context
  snapshots; the one declared here carries content, model, usage, stop reason and a timestamp.
  Because assignability runs the permissive way, a wide value satisfies a narrow type without a
  word from the compiler, which is how the header collision below shipped undeclared host fields
  to guests. The prefix is what makes the compiler ask for a projection.
- `SessionHeader` is now `WireSessionHeader`, for the same reason and in the same pass as
  `WireSessionEntry` above. The old name is kept as a renamed export.
- `SessionEntry` is now `WireSessionEntry`. Three packages each declared a `SessionEntry`, all of
  them unions of session entries, all of them different widths: this one is the six variants a
  browser guest can render, `@veyyon/agent-core`'s is the host's full union of a dozen-plus, and
  `@veyyon/stats`'s admits any object with a `type` at all. Near-identical is worse than different
  because the wrong import typechecks, and the host already had to write
  `import { SessionEntry as WireSessionEntry }` beside `import { SessionEntry as StoredSessionEntry }`
  to say which one it meant. The old name is kept as a renamed export, so existing imports keep
  working; prefer `WireSessionEntry` in new code.

### Fixed

- Collab guests no longer disagree about when a host has stopped answering. The TUI guest and the web
  client each kept their own copy of the three join budgets, and `TRANSCRIPT_TIMEOUT_MS` had drifted to
  10 s in the browser against 20 s in the terminal. A host taking 15 s to read a large transcript
  answered the terminal fine and looked dead to a web viewer, which resolves the fetch to `null` on
  timeout. Both now read 20 s from this package.
- The module header cited a conformance test that did not exist. Conformance is now asserted per entry
  variant in `packages/coding-agent/test/collab/web-wire-conformance.test.ts`, which fails the
  typecheck when a host-side session entry stops being assignable to its wire shape.
