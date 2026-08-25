#!/usr/bin/env bash
# A login that fails leaves the provider's explanation on screen.
#
# Before: #loginThenReopenAccountManager reopened the card unconditionally, so
#         the fullscreen card drew straight over the error in the transcript.
# After:  a failed outcome leaves the card unmounted, so the operator can read
#         why the provider rejected the attempt.

# Start the local HTTPS stub proxy that returns Command Code's 403 plan-limit response.
mkdir -p /sandbox/home 2>/dev/null || true
openssl req -x509 -newkey rsa:2048 -keyout /sandbox/home/stub-key.pem -out /sandbox/home/stub-cert.pem -days 1 -nodes -subj "/CN=api.commandcode.ai" 2>/dev/null || true

bun -e '
import net from "node:net";
import https from "node:https";
import fs from "node:fs";

const cert = fs.readFileSync("/sandbox/home/stub-cert.pem");
const key = fs.readFileSync("/sandbox/home/stub-key.pem");

const httpsServer = https.createServer({ cert, key }, (req, res) => {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: {
      message: "Your Go plan doesn'\''t include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
      type: "permission_error",
      code: "upgrade_required"
    }
  }));
}).listen(9002);

const proxyServer = net.createServer(socket => {
  socket.once("data", chunk => {
    const str = chunk.toString();
    if (str.startsWith("CONNECT")) {
      const target = net.connect(9002, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(target);
        target.pipe(socket);
      });
      target.on("error", () => socket.destroy());
    }
  });
}).listen(9003);
' >/dev/null 2>&1 &
STUB_PID=$!

cleanup_stub() {
	kill "${STUB_PID}" 2>/dev/null || true
	rm -f /sandbox/home/stub-key.pem /sandbox/home/stub-cert.pem
}
trap cleanup_stub EXIT

settle 18
shot idle

# Open the account manager card via slash command.
slash "/account manager"
settle 4
shot account-manager-open

# Focus the sidebar and navigate down to Command Code (7th entry: index 6).
k Left
pause 0.3
key_repeat Down 6 0.1
pause 0.5
shot command-code-selected

# Trigger add account for Command Code.
k a
settle 3
shot key-prompt

# Supply an invalid API key and submit.
t "sk-invalid-command-code-token"
pause 0.5
k Return
settle 6

# The result frame:
# Before fix: the account manager card remounts on top of the error.
# After fix: the card stays closed and the provider's reason is readable.
shot failed-login-result
