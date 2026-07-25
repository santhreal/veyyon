# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

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

### Fixed

- Collab guests no longer disagree about when a host has stopped answering. The TUI guest and the web
  client each kept their own copy of the three join budgets, and `TRANSCRIPT_TIMEOUT_MS` had drifted to
  10 s in the browser against 20 s in the terminal. A host taking 15 s to read a large transcript
  answered the terminal fine and looked dead to a web viewer, which resolves the fetch to `null` on
  timeout. Both now read 20 s from this package.
- The module header cited a conformance test that did not exist. Conformance is now asserted per entry
  variant in `packages/coding-agent/test/collab/web-wire-conformance.test.ts`, which fails the
  typecheck when a host-side session entry stops being assignable to its wire shape.

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
