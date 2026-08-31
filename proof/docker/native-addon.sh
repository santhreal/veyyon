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
require_native_addon() {
	local repo="${1:?require_native_addon <repo-root>}"
	compgen -G "${repo}/packages/natives/native/veyyon_natives.linux-x64*.node" >/dev/null && return 0
	echo "recorder: no linux-x64 napi addon in packages/natives/native" >&2
	echo "recorder: the product would exit before it drew a frame. Provision it with:" >&2
	echo "  bun --cwd=packages/natives run ensure" >&2
	return 1
}
