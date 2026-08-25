#!/usr/bin/env bash
# Scope ImageMagick's named magick-* pixel-cache files to a directory the caller
# deletes. ImageMagick 6's convert, import and magick spill a pixel cache to disk
# as magick-* names when an operation will not fit in RAM (a blurred 2560x1440
# backdrop, a 20k-px test PNG). On a clean exit those names are unlinked; SIGKILL
# leaves them. Unscoped they land in /tmp and exhaust inodes. This never sweeps
# /tmp: it names a directory we own, and the caller removes that directory.
#
#   source proof/docker/magick-tmpdir.sh
#   magick_tmpdir_scope <parent-dir>
#   magick_tmpdir_release   # from the caller's existing EXIT handler
#
# magick_tmpdir_scope is idempotent for a single shell: a second call is a no-op
# so a session script and a publish script can both source this.

magick_tmpdir_scope() {
	local parent="${1:?magick_tmpdir_scope <parent-dir>}"
	if [ -n "${MAGICK_SCOPED_TMPDIR:-}" ] && [ -n "${MAGICK_SCOPED_TMPDIR_TOKEN:-}" ] && [ -d "${MAGICK_SCOPED_TMPDIR}" ]; then
		case "$(basename "${MAGICK_SCOPED_TMPDIR}")" in
		veyyon-magick.*)
			local inherited_token=
			IFS= read -r inherited_token <"${MAGICK_SCOPED_TMPDIR}/.veyyon-magick-scope" 2>/dev/null || true
			if [ "${inherited_token}" = "${MAGICK_SCOPED_TMPDIR_TOKEN}" ]; then
				return 0
			fi
			;;
		esac
	fi
	parent="${parent%/}"
	mkdir -p "${parent}" 2>/dev/null || return 1
	local tmp
	tmp="$(mktemp -d "${parent}/veyyon-magick.XXXXXX" 2>/dev/null)" || return 1
	if [ -z "${tmp}" ] || [ ! -d "${tmp}" ]; then
		return 1
	fi
	local token
	token="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')" || {
		rm -rf "${tmp}" 2>/dev/null || true
		return 1
	}
	if [ -z "${token}" ] || ! printf '%s\n' "${token}" >"${tmp}/.veyyon-magick-scope"; then
		rm -rf "${tmp}" 2>/dev/null || true
		return 1
	fi
	MAGICK_SCOPED_TMPDIR="${tmp}"
	MAGICK_SCOPED_TMPDIR_TOKEN="${token}"
	export MAGICK_SCOPED_TMPDIR
	export MAGICK_SCOPED_TMPDIR_TOKEN
	export MAGICK_TMPDIR="${MAGICK_SCOPED_TMPDIR}"
	export MAGICK_TEMPORARY_PATH="${MAGICK_SCOPED_TMPDIR}"
}

magick_tmpdir_release() {
	local dir="${MAGICK_SCOPED_TMPDIR:-}"
	local token="${MAGICK_SCOPED_TMPDIR_TOKEN:-}"
	if [ -n "${dir}" ] && [ -n "${token}" ] && [ -d "${dir}" ]; then
		case "$(basename "${dir}")" in
		veyyon-magick.*)
			local stored_token=
			IFS= read -r stored_token <"${dir}/.veyyon-magick-scope" 2>/dev/null || true
			if [ "${stored_token}" = "${token}" ]; then
				rm -rf "${dir}"
			fi
			;;
		esac
	fi
	unset MAGICK_SCOPED_TMPDIR
	unset MAGICK_SCOPED_TMPDIR_TOKEN
	unset MAGICK_TMPDIR
	unset MAGICK_TEMPORARY_PATH
}
