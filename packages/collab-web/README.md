# @veyyon/collab-web

Browser client for Veyyon collab live sessions. Displays streaming transcripts, tool-call cards, and subagent panels, with an input composer for interacting with the host agent.

Documentation: [`docs/handbook/src/features/collab.md`](../../docs/handbook/src/features/collab.md)

## Quick start

```sh
# Development server (http://localhost:3000):
bun run dev

# Offline mock host:
bun run mock-host
```

Connect using a generated session URL or deep link (`http://localhost:3000/#<roomId>.<key>`).

## Build and deployment

```sh
bun run build   # outputs static assets to dist/
```

Runtime requirements:
- **Secure context:** WebCrypto APIs (`crypto.subtle`) require an `https://` origin or `localhost`.
- **Relay connection:** WebSocket connection to relay server (`wss://share.veyyon.dev` by default).

Room keys remain in the URL fragment and are not transmitted to relay servers.

## Architecture

- `src/lib/`: Wire protocol bindings over `@veyyon/wire` (`codec.ts` for AES-256-GCM encryption, `link.ts` for link parsing, `socket.ts` for relay connection management, `client.ts` for session state).
- `src/components/`: UI components (`transcript/`, `agents/`, `shell/`).
- `src/tool-render/`: Local tool rendering integrations and web component implementation (`<vey-tool-view>`).
- `scripts/`: Dev relay server (`local-relay.ts`) and mock host runner (`mock-host.ts`).

The package depends on `@veyyon/wire` contracts and has no runtime dependency on `@veyyon/coding-agent`.
