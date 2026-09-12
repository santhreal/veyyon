#!/usr/bin/env bash
# Shared workspace scratch directory allocation and lifecycle for recording sessions.
#
#   source proof/docker/session-scratch.sh
#   session_scratch_init <out-dir> <scene-name>
#   session_scratch_cleanup
#
# WHY THIS FILE EXISTS. Both session launchers (xsession.sh and wlsession.sh)
# require an isolated scratch directory under /out so work products (logs,
# geometry, sockets, bootstrap scripts, backdrop renders) never touch /tmp.
#
# A default hardcoded in multiple session scripts duplicates configuration and
# risks path drift. SCENE_SCRATCH_DIR in proof/docker/scene-config.sh is the single
# source of truth for the default parent path.
#
# Safety invariants:
#   1. The canonical configured parent is validated to reside under /out BEFORE any
#      directory creation, preventing arbitrary path creation outside the workspace.
#   2. A unique child directory is allocated with mktemp -d for this invocation.
#   3. Cleanup removes ONLY the unique owned child directory created by this run,
#      never deleting pre-existing parent directories or sibling captures.

session_scratch_init() {
	local out="${1:?session_scratch_init <out-dir> <scene-name>}"
	local name="${2:?session_scratch_init <out-dir> <scene-name>}"
	mkdir -p "${out}" || return 1
	out="$(cd "${out}" && pwd -P)" || return 1

	local parent="${SCENE_SCRATCH_DIR:?session_scratch_init: SCENE_SCRATCH_DIR must be set by scene-config.sh}"
	case "${parent}" in
	/*) ;;
	*) parent="${out}/${parent}" ;;
	esac
	local canonical_parent
	canonical_parent="$(realpath -m "${parent}" 2>/dev/null || true)"
	if [ -z "${canonical_parent}" ]; then
		echo "session-scratch: failed to resolve canonical path for SCENE_SCRATCH_DIR '${parent}'" >&2
		return 1
	fi

	case "${canonical_parent}" in
	"${out}" | "${out}/"*) ;;
	*)
		echo "session-scratch: SCENE_SCRATCH_DIR (${canonical_parent}) must be located under ${out}" >&2
		return 1
		;;
	esac

	mkdir -p "${canonical_parent}" || return 1
	local owned
	owned="$(mktemp -d "${canonical_parent}/session-${name}-XXXXXX" 2>/dev/null)" || {
		echo "session-scratch: failed to create unique scratch directory under ${canonical_parent}" >&2
		return 1
	}

	SESSION_SCRATCH_ROOT="${out}"
	SESSION_OWNED_SCRATCH="${owned}"
	export SESSION_SCRATCH_ROOT
	export SESSION_OWNED_SCRATCH
	export TMPDIR="${SESSION_OWNED_SCRATCH}"
	export KITTY_SOCKET="unix:${TMPDIR}/kitty.sock"
}

session_scratch_cleanup() {
	local dir="${SESSION_OWNED_SCRATCH:-}"
	local root="${SESSION_SCRATCH_ROOT:-}"
	if [ -n "${root}" ] && [ -n "${dir}" ] && [ -d "${dir}" ]; then
		case "${dir}" in
		"${root}/"*)
			rm -rf "${dir}"
			;;
		esac
	fi
	unset SESSION_OWNED_SCRATCH
	unset SESSION_SCRATCH_ROOT
}
