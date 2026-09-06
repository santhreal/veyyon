#!/usr/bin/env bash
# Host-side preflight: the napi addon the recorded product needs.
#
#   source proof/docker/native-addon.sh && require_native_addon "${REPO_ROOT}"
#
# The container runs the product out of the bind-mounted checkout, so the addon
# has to exist on this side before docker starts. A checkout without it boots the
# CLI as far as the native loader, which exits after listing every path it tried.
# The terminal exits with its child and what reaches the host is a black video
# and stills of an empty root, with the addon named nowhere in the capture path.
#
# Provisioning needs the network and a bun, which the host has and the recorder
# image does not, so the check lives here rather than in a session script, and it
# fails closed with the command that fixes it.
#
# PROOF_NATIVE_ADDON names the file to accept instead of the checkout's own, the
# way RENDER_NODE names the render node: a caller that stubs docker and reads the
# argv never starts a container, so it stages a path and skips provisioning.
require_native_addon() {
	local repo="${1:?require_native_addon <repo-root>}"
	if [ -n "${PROOF_NATIVE_ADDON:-}" ]; then
		[ -e "${PROOF_NATIVE_ADDON}" ] && return 0
		echo "recorder: PROOF_NATIVE_ADDON=${PROOF_NATIVE_ADDON} does not exist" >&2
		return 1
	fi
	compgen -G "${repo}/natives/bridge/bindings/native/veyyon_natives.linux-x64*.node" >/dev/null && return 0
	compgen -G "${repo}/packages/natives/native/veyyon_natives.linux-x64*.node" >/dev/null && return 0
	echo "recorder: no linux-x64 napi addon in natives/bridge/bindings/native" >&2
	echo "recorder: the product would exit before it drew a frame. Provision it with:" >&2
	echo "  bun --cwd=natives/bridge/bindings run ensure" >&2
	return 1
}
