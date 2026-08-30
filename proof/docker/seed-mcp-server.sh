#!/usr/bin/env bash
# A disabled stdio MCP server whose command never completes its handshake.
#
# A scene photographing the row a surface shows while it waits needs a wait that
# lasts longer than a frame. Every other wait in the product is over in
# milliseconds or needs a provider: a compaction needs a dozen real turns first,
# a share needs the network, and a model download needs weights. An MCP server
# is the one wait a container can produce on its own, because the transport is a
# process the product spawns and `sleep` is a process that answers nothing.
#
# So the config carries one server, disabled, whose command sleeps. `/mcp enable`
# connects it, the handshake never arrives, and the animated connecting row holds
# the screen for the ten seconds the product waits before it reports the server
# as still connecting. Both rows are the class under capture.
#
# NO NETWORK AND NO MODEL: the transport is a local process and the row is drawn
# by the product reading its own connection state.
#
#   seed-mcp-server.sh <agent-dir>
set -euo pipefail

AGENT_DIR="${1:?agent dir required}"

mkdir -p "${AGENT_DIR}"

cat >"${AGENT_DIR}/mcp.json" <<'JSON'
{
	"mcpServers": {
		"slow-notes": {
			"type": "stdio",
			"command": "sleep",
			"args": ["300"],
			"enabled": false
		}
	}
}
JSON
