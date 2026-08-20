#!/bin/sh
set -e

# Veyyon installer
# Usage: curl -fsSL https://get.veyyon.dev | sh
#   or:  curl -fsSL https://raw.githubusercontent.com/santhreal/veyyon/main/scripts/install.sh | sh
#
# This installs the prebuilt self-contained binary: one verified download, no
# toolchain, nothing from a package registry. It NEVER clones this repository and
# never builds from source. To run an unreleased ref, or to work on veyyon, clone
# the repository yourself and run `bun run setup` in that checkout.
#
# The options live in usage() below, which is also what `--help` prints. One
# place: a list here as well would be the copy that goes stale, and it is the
# copy nobody reading `--help` would ever see.
#
# After install, launch with `vey` in any repo.

REPO="santhreal/veyyon"
BIN_NAME="veyyon"
ALIAS_NAME="vey"
# Whether `$ALIAS_NAME` next to the binary is an alias THIS installer owns.
#
# One owner: link_alias makes the call (it is the only code that inspects and
# writes the alias) and records it here; install_completions and doctor read it
# rather than each re-deriving the answer. Re-deriving needed `readlink`, which
# doctor cannot depend on: doctor exists to diagnose a broken PATH, and on a
# broken PATH the fork fails and the alias silently reads as "not ours". 0 until
# link_alias has actually run, so nothing assumes ownership it has not checked.
ALIAS_IS_OURS=0
# Set by ensure_on_path when the install directory was missing from the PATH of
# the shell running this script, which is what makes the closing advice depend on
# a reload. `PATH_RELOAD_RC` is the file to source, empty when there was none.
PATH_NEEDS_RELOAD=0
PATH_RELOAD_RC=""
# Where the binary and the alias go, resolved on every use rather than when this
# file is sourced — same reason as src_dir below: a $HOME set after sourcing
# must be followed, and this path guards removals. It also collapses two names
# for one thing: callers were setting INSTALL_DIR and VEYYON_INSTALL_DIR
# together because it was not obvious which one was read.
#
# A trailing slash is stripped, because everything downstream compares this
# against a path that has none: the PATH membership test (`*":$dir:"*`), the rc
# line the uninstall matches back byte-for-byte, and the shadow check's
# `dir_of "$bin"`. `VEYYON_INSTALL_DIR=$HOME/.local/bin/` is a spelling a person
# types, and it used to make the installer write a PATH entry it could not
# afterwards recognize as its own — so a reinstall added a second one and the
# uninstall left both behind. `/` keeps its slash: it is the directory, not a
# trailing separator.
install_dir() {
    if [ -n "${VEYYON_INSTALL_DIR:-}" ]; then
        _id_dir="$VEYYON_INSTALL_DIR"
    else
        # A HOME spelled with a trailing slash would otherwise build
        # `/home/you//.local/bin`, which every tool resolves to the same
        # directory and no string comparison recognizes as the one we wrote.
        _id_home="$HOME"
        while [ "${_id_home%/}" != "$_id_home" ] && [ "$_id_home" != "/" ]; do
            _id_home="${_id_home%/}"
        done
        [ "$_id_home" = "/" ] && _id_home=""
        _id_dir="$_id_home/.local/bin"
    fi
    while [ "${_id_dir%/}" != "$_id_dir" ] && [ "$_id_dir" != "/" ]; do
        _id_dir="${_id_dir%/}"
    done
    printf '%s' "$_id_dir"
}

# Retry transient network failures on every download (a dropped connection or a
# 5xx/429 from GitHub should not fail the whole install on the first blip). Kept
# in one place so every curl fetch below retries the same way. Only `--retry`
# and `--retry-delay` are used: both are in curl since 7.12 (2004), so this does
# not break an old curl the way `--retry-connrefused` (7.52+) would.
# NOTE: this is expanded UNQUOTED at each call site ($CURL_RETRY, not
# "$CURL_RETRY") on purpose, so the flags word-split into separate curl
# arguments. Do not quote it (shellcheck SC2086 is wrong here): quoting passes
# the whole string as one argument and curl rejects it.
CURL_RETRY="--retry 3 --retry-delay 1"

# What to tell someone the installer cannot serve: an unsupported platform, or a
# ref with no published release. The user owns the checkout and runs the clone;
# the installer does not, which is why this is prose and not a flag. It used to
# be a `--source` suggestion, and that flag cloned into $HOME/.veyyon/src behind
# the user's back, leaving a second divergent copy of the product on the machine.
MANUAL_BUILD="build it from a checkout you own: git clone https://github.com/${REPO}.git && cd veyyon && bun run setup"

MODE=""
REF=""
VERIFY=1
DO_UNINSTALL=0
FORCE=0

# What the installer can be asked to do. The single owner of the option list:
# `--help` prints this, and the header of this file points here rather than
# carrying a second copy to go stale.
#
# It exists at all because `sh install.sh --help` used to answer
# "Unknown option: --help" and exit 1. The options were documented in a comment
# at the top of the file, which is precisely what a
# `curl … | sh` install never shows anyone.
usage() {
    cat <<USAGE
veyyon installer

  curl -fsSL https://get.veyyon.dev | sh                     install the latest release
  curl -fsSL https://get.veyyon.dev | sh -s -- <options>     with options

Options:
  --binary          Install the prebuilt binary (the default; no toolchain needed)
  --local           Install the binary this checkout already built, from dist/vey
  --ref <ref>       Install a specific published release tag. A bare version
                    resolves to its tag, so 1.0.37 and v1.0.37 are the same
                    release. Branches and commits are not installable: clone the
                    repository and run \`bun run setup\` in that checkout instead.
  -r <ref>          Shorthand for --ref
  --no-verify       Skip the download's checksum verification (NOT recommended)
  --force           Install over a file at the target path that this installer
                    cannot account for. That file is moved aside to
                    <name>.unowned.<pid> and its path printed; nothing is deleted
  --uninstall       Remove veyyon, the \`vey\` alias, completions, and any source
                    checkout an older installer left behind
  -h, --help        Print this and exit

Environment:
  VEYYON_INSTALL_DIR   Where the binary goes (default \$HOME/.local/bin)

After install, launch with \`vey\` in any repository.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --local) MODE="local"; shift ;;
        --binary) MODE="binary"; shift ;;
        --uninstall) DO_UNINSTALL=1; shift ;;
        --no-verify) VERIFY=0; shift ;;
        --force) FORCE=1; shift ;;
        --ref)
            shift
            [ -z "$1" ] && { echo "Missing value for --ref" >&2; exit 1; }
            REF="$1"; shift ;;
        --ref=*)
            REF="${1#*=}"
            [ -z "$REF" ] && { echo "Missing value for --ref" >&2; exit 1; }
            shift ;;
        -r)
            shift
            [ -z "$1" ] && { echo "Missing value for -r" >&2; exit 1; }
            REF="$1"; shift ;;
        -h|--help) usage; exit 0 ;;
        # A bad option prints the list rather than only the complaint: the
        # options are not visible anywhere else to someone who installed by
        # piping this script into a shell.
        *) echo "Unknown option: $1" >&2; echo "" >&2; usage >&2; exit 1 ;;
    esac
done


# ---- color ----
# The install is the first thing anyone ever sees of veyyon and it rendered in
# the same monochrome as any package manager, so the one line that says the
# install worked looked exactly like the twelve lines of progress above it.
# Color is applied only where it carries meaning: the status glyph, and the
# completion line.
#
# Three conditions, all of which have to hold. Stdout must be a terminal, so
# `| tee install.log` and a CI log get plain bytes and every existing assertion
# over this script's output keeps matching. NO_COLOR (https://no-color.org) and
# TERM=dumb are the two ways a person says they do not want it, and both are
# honored. One place decides; nothing below writes an escape inline.
#
# `IS_TTY` is answered HERE, once, at the top of the script, and every later
# question about the terminal reads it. `[ -t 1 ]` asks about the stdout of
# whatever is running at that moment, so asking it again from inside a `$( )`
# always answers "no": the substitution's stdout is a pipe by construction. That
# is not a hypothetical — the width lookup did exactly this, decided there was no
# terminal, and silently disabled wrapping on every terminal there is.
if [ -t 1 ]; then IS_TTY=1; else IS_TTY=0; fi
if [ "$IS_TTY" = 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    C_RESET=$(printf '\033[0m')
    C_BOLD=$(printf '\033[1m')
    C_DIM=$(printf '\033[2m')
    C_OK=$(printf '\033[32m')
    C_WARN=$(printf '\033[33m')
    C_ERR=$(printf '\033[31m')
else
    C_RESET='' C_BOLD='' C_DIM='' C_OK='' C_WARN='' C_ERR=''
    HAS_COLOR=0
fi
[ "${HAS_COLOR:-1}" = 0 ] || HAS_COLOR=1

# ---- the mark ----
# The sun IS the logo, and the install had none of it: the first thing anyone
# ever saw of veyyon was a line of lowercase progress text.
#
# One line, printed once, before anything happens. A disc drawn from the ember
# ramp, then the name letterspaced in silver, which is the same order the setup
# splash uses — the eye lands on the sun, the name second.
#
# `packages/coding-agent/src/modes/components/sun.ts` is the OWNER of the brand
# ember and of the glyph ramp; the values below are bands 2, 4, 6 and 7 of its
# `EMBER` array and glyphs from its `GLYPH` ramp, quoted rather than reinvented.
# `scripts/installer-brand-parity.test.ts` reads both files and fails if they
# drift, because two shipped suns that disagree are worse than one plain line.
#
# Three renderings, narrowest capability last. Truecolor gets the real ember.
# A 256-color terminal gets the xterm approximation the TUI already falls back
# to. Anything else, including a terminal whose locale is not UTF-8 and would
# render the block glyphs as mojibake, gets an ASCII disc — a wrong-looking
# logo is worse than a plain one.
BRAND_NAME_SPACED="v e y y o n"
supports_utf8() {
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *[Uu][Tt][Ff]*) return 0 ;; esac
    return 1
}
brand_mark() {
    [ "$IS_TTY" = 1 ] || return 0
    if [ "$HAS_COLOR" = 0 ] || ! supports_utf8; then
        printf '\n  (*) %s\n\n' "$BRAND_NAME_SPACED"
        return
    fi
    # Silver for the name, matching the splash's wordmark rather than the ember.
    _bm_silver=$(printf '\033[38;2;198;203;212m')
    # Lower blocks of rising height, so the silhouette is a dome: the sun coming
    # up over its own horizon, which is the setup splash's sunrise compressed
    # onto one line. Every cell is SOLID and the color carries the heat.
    #
    # Two earlier attempts, both discarded after rendering them to an image on a
    # grey and a black ground. Shading with the owner's `░ ▒ ▓` ramp the way the
    # TUI does washed the whole thing out: a terminal draws those as a dot
    # pattern of the foreground over the background, so an ember `▒` averages to
    # a muted brown-grey and the mark read as a grey swatch. The TUI can shade
    # because it has a field of cells to average across; seven cells cannot.
    # Solid full blocks fixed the color and left a rectangle, which reads as a
    # progress bar. The height profile is what makes it a sun.
    case "${COLORTERM:-}" in
        truecolor|24bit)
            # EMBER bands 1, 4, 6, 7, 6, 4, 1: a dark rim, then band 4, which is
            # the brand ember the website's `--sun` and the setup splash both
            # rest on, then out to the white-hot core and symmetrically back. The
            # brand color is deliberately IN the ramp rather than near it.
            _bm_disc=$(printf '\033[38;2;110;52;24m▁\033[38;2;240;134;46m▃\033[38;2;251;192;109m▅\033[38;2;255;227;173m█\033[38;2;251;192;109m▅\033[38;2;240;134;46m▃\033[38;2;110;52;24m▁')
            ;;
        *)
            # EMBER_256, same ordering: 88, 208, 220, 223.
            _bm_disc=$(printf '\033[38;5;88m▁\033[38;5;208m▃\033[38;5;220m▅\033[38;5;223m█\033[38;5;220m▅\033[38;5;208m▃\033[38;5;88m▁')
            ;;
    esac
    printf '\n  %s%s   %s%s%s%s\n\n' "$_bm_disc" "$C_RESET" "$_bm_silver" "$C_BOLD" "$BRAND_NAME_SPACED" "$C_RESET"
}

# The terminal's width, or 0 when there is nothing to wrap to.
#
# 0 for a pipe, a log file and a CI run, which is what keeps this script's output
# byte-identical everywhere it is captured or asserted on.
#
# Three sources, in the order they deserve trust. `COLUMNS` first, because a user
# who exported one means it. Then `tput cols`, which is the standard answer and
# needs both a terminfo database and ncurses installed. Then `stty size`, because
# a minimal container has neither: the image this was first dogfooded in had no
# `tput` at all, so every long message fell back to unwrapped, which looked
# exactly like the bug this exists to fix. Falling all the way through to 0 means
# "width unknown", and an unknown width prints one line rather than guessing 80
# and wrapping a 200-column terminal into a narrow column.
# A width is usable only if it is digits and at least 24. Every source here can
# hand back something that is neither: `tput cols` answered a literal `0` in the
# container this was dogfooded in, and a `0` is non-empty, so a plain
# "did it print anything" test accepted it and disabled wrapping while looking
# like it had found a width. Validating each candidate is what lets the chain
# fall through to the next source instead of stopping at a bad answer.
usable_width() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 24 ]; }
term_cols() {
    [ "$IS_TTY" = 1 ] || { printf '0\n'; return; }
    if usable_width "${COLUMNS:-}"; then printf '%s\n' "$COLUMNS"; return; fi
    _tc=$(tput cols 2>/dev/null)
    if usable_width "$_tc"; then printf '%s\n' "$_tc"; return; fi
    # `stty size` prints "<rows> <cols>"; the second field is the one wanted.
    _tc=$(stty size 2>/dev/null | awk '{ print $2 }')
    if usable_width "$_tc"; then printf '%s\n' "$_tc"; return; fi
    printf '0\n'
}

# Print a message under a two-character status glyph, wrapping continuation lines
# under the TEXT rather than under the glyph.
#
# An unwrapped message longer than the terminal is broken mid-word by the
# terminal itself and its remainder starts at column 0, so a warning about bash
# completions read as `…so those completions d` / `o nothing yet` with the tail
# hanging off the left margin, indistinguishable from a new message. Wrapping is
# done here, on word boundaries, with a six-space hanging indent that lines the
# continuation up with the first word.
#
# A message that starts with spaces keeps them, on the first line and on every
# continuation. Some messages indent themselves a further four spaces to say "I
# belong to the warning above me" — the `fix:` line under a completion warning is
# one — and collapsing that indent turns a follow-on into what looks like a
# separate, unrelated warning.
#
# Width 0 (a pipe, a log, a test) prints the message on one line exactly as it
# always has: wrapping output nobody is looking at only makes it harder to grep.
# Wrap one message to the terminal, with a first-line prefix and a continuation
# prefix that keeps the text in the same column.
#
# The one wrapper. `glyph_line` grew it for its own "  ok  " gutter, and every
# other multi-word line the installer prints then had to either be short enough
# by luck or run off the edge — which is exactly what the "or: source <profile>"
# hint under the reload step did, at 40 and at 60 columns.
#
# The message's OWN leading spaces are preserved and applied to continuations
# too: without that, a line indented to read as a follow-on to the one above it
# lost the indent on wrap and read as a separate message.
wrap_line() { # first-prefix, continuation-prefix, visible-prefix-width, message...
    _wl_head=$1; _wl_cont=$2; _wl_pad=$3; shift 3
    _wl_cols=$(term_cols)
    # Under 24 columns there is no width to wrap into: every break would leave
    # one or two characters on a line. Print it whole and let the terminal do
    # whatever it does.
    if [ "$_wl_cols" -lt 24 ]; then
        printf '%s%s\n' "$_wl_head" "$*"
        return
    fi
    printf '%s' "$*" | awk -v w="$((_wl_cols - _wl_pad))" -v head="$_wl_head" -v cont="$_wl_cont" '
        {
            match($0, /^ */)
            lead = substr($0, 1, RLENGTH)
            $0 = substr($0, RLENGTH + 1)
            w -= length(lead)
            n = split($0, word, " ")
            line = ""
            prefix = head lead
            for (i = 1; i <= n; i++) {
                cand = (line == "" ? word[i] : line " " word[i])
                # A single word longer than the width still gets its own line:
                # breaking a path or a URL to fit would make it uncopyable.
                if (length(cand) > w && line != "") {
                    print prefix line
                    prefix = cont lead
                    line = word[i]
                } else {
                    line = cand
                }
            }
            if (line != "") print prefix line
        }'
}

# The glyph gutter is "  ok  ": two spaces, a two-character marker, two spaces.
# Six visible columns, whatever the color escapes around the marker weigh, which
# is why the width is passed separately from the prefix string. A continuation
# starts under the first word rather than under the marker.
glyph_line() { # glyph, color, message...
    _gl_glyph=$1; _gl_color=$2; shift 2
    wrap_line "  ${_gl_color}${_gl_glyph}${C_RESET}  " "      " 6 "$@"
}

# ---- small ui helpers (silver-on-black brand voice: quiet, honest) ----
say()  { printf '%s\n' "$*"; }
# The glyph carries the color, never the message: a green sentence is harder to
# read than a green two-character marker, and a colored message would fight the
# paths and command names inside it.
ok()   { glyph_line "ok" "$C_OK" "$*"; }
warn() { glyph_line "!!" "$C_WARN" "$*" >&2; }
# Lines in a file, counting a final line with no newline. `wc -l` does not.
count_lines() { awk 'END { print NR }' "$1"; }
die()  { glyph_line "xx" "$C_ERR" "$*" >&2; exit 1; }
# Progress narration: what the installer is doing right now, dimmed so the `ok`
# lines that record what it DID are what the eye lands on.
step() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

has() { command -v "$1" >/dev/null 2>&1; }

# Every network fetch in this installer is curl, so its absence is a preflight
# failure and not a network failure.
#
# Without this the first fetch fails the way an unreachable host does, and the
# install dies with "could not reach https://github.com/... (network error, or
# GitHub is down)" on a machine whose network is fine. The user then goes looking
# at DNS, a proxy and a firewall for a missing package. A minimal container image
# and a stripped CI runner are where this actually happens, and both are places
# people install from a `wget -qO- ... | sh` one-liner, which is exactly how you
# get here with wget present and curl not.
require_curl() {
    has curl || die "curl is required and is not installed. Install it with your package manager (apt install curl / dnf install curl / apk add curl / brew install curl) and run this again."
}

# ---- resolve a release tag WITHOUT the GitHub API ----
# api.github.com is capped at 60 requests/hour PER IP for unauthenticated
# callers, and that budget is shared by everyone behind the same address. A CI
# fleet, an office NAT or a container host that installs veyyon a few dozen times
# in an hour used to stop being able to install it at all: the release lookup
# came back 403 and the script died on a machine where nothing was wrong. An
# adversarial matrix run hit exactly that, six times, on an installer that was
# working perfectly.
#
# github.com itself is not part of that budget. `/releases/latest` is a redirect
# to the tag page of the newest non-prerelease release, and `/releases/tag/<tag>`
# is a 404 for a tag that does not exist, which is the only thing the two API
# calls were ever read for. It is also the same host the binary is downloaded
# from, so the install now depends on one host instead of two and needs no token
# at all.
#
# `-o /dev/null -w %{url_effective}` asks curl where it ENDED UP rather than for
# the page body, so nothing is parsed out of HTML.
resolve_latest_tag() {
    # -I asks for headers only. The tag is in the URL curl ends up at, so the
    # release page's body is a few hundred kilobytes nobody reads; -L still
    # follows the redirect to find it.
    _rlt_url=$(curl -fsSIL -o /dev/null -w '%{url_effective}' $CURL_RETRY \
        --connect-timeout 10 --max-time 60 "https://github.com/${REPO}/releases/latest" 2>/dev/null) || return 1
    # A redirect that did not land on a tag page means GitHub answered with
    # something other than a release — an interstitial, a moved repo, a captive
    # portal. Fail rather than install whatever the last path segment happened to
    # be, which is how you end up downloading `latest` as a version number.
    case "$_rlt_url" in
        *"/releases/tag/"*) ;;
        *) return 1 ;;
    esac
    _rlt_tag="${_rlt_url##*/releases/tag/}"
    [ -n "$_rlt_tag" ] || return 1
    printf '%s\n' "$_rlt_tag"
}

# What state a tag is in, as far as installing a prebuilt binary is concerned:
#   0  a published release with downloadable assets  (install can proceed)
#   2  a real tag with no installable release        (bare tag, or a draft)
#   1  no such tag
#
# This used to HEAD `/releases/tag/<tag>` and read a 200 as "the release is
# published". GitHub renders that page for ANY tag that exists, with or without a
# release object attached, and an unpublished draft is invisible there too, so
# the check passed for tags that cannot be installed at all. The install then got
# as far as the asset download and died with "not published for this release?",
# which blames the platform binary and sends the user off to build from source
# for a release that was never cut. The rollback runbook pins `--ref vX.Y.Z`, so
# that misdirection landed on people already having a bad day.
#
# `/releases/expanded_assets/<tag>` is the fragment GitHub lazy-loads into the
# release page's asset list, and it answers all three states in one request:
# 404 for a tag that does not exist; for a bare tag or a draft it renders the two
# source-archive links and nothing else; only a published release lists
# `/releases/download/<tag>/` hrefs. The presence of one of those hrefs is
# exactly the question the installer needs answered, and it is the same signal it
# already trusts, since that href IS the URL the binary is fetched from.
#
# github.com, not the API, for the reason spelled out above resolve_latest_tag:
# api.github.com's 60/hour unauthenticated budget is shared by everyone behind
# one address, and an install must not be able to fail because a neighbour spent
# it. The fragment is a few kilobytes for a tag with no release and well under a
# tenth of the release page for one with.
#
# Nothing is parsed out of the HTML: the body is tested for a URL prefix, not
# read for a value. A tag cannot contain a glob metacharacter (git refuses `*`,
# `?` and `[`), so it is safe as the pattern it is spliced into.
release_tag_state() {
    _rts_body=$(curl -fsSL $CURL_RETRY --connect-timeout 10 --max-time 60 \
        "https://github.com/${REPO}/releases/expanded_assets/$1" 2>/dev/null) || return 1
    case "$_rts_body" in
        *"/${REPO}/releases/download/$1/"*) return 0 ;;
    esac
    return 2
}

# The published tag for a `--ref` a person typed. Prints nothing, and only
# nothing, when no tag by either spelling exists at all.
#
# Releases are tagged `v1.0.37`, and `--ref 1.0.37` is what people type: same
# version, one character short of a tag that exists. Refusing it names a real
# fact ("no such tag") and leaves the user to guess which of the two spellings
# this project uses, so the `v` form is tried as well. The resolution is
# ANNOUNCED by the caller, not applied quietly: the version the install proceeds
# with must be the version on screen.
#
# Only that one spelling, and only when the request has no `v` and reads as a
# version. A wider search would start guessing at tags the user did not ask for,
# and installing a version nobody named is worse than refusing.
#
# The exit status carries which way it failed, because the two need different
# things said: 2 is "that tag is real but has no release you can install", 1 is
# "there is no such tag". Collapsing them is how a tag with no release spent a
# release cycle being reported as a missing platform binary.
#
# On 2 the tag that DOES exist is still printed, so the caller can name it in the
# manual-build advice: `--ref 1.0.39` is not a ref git can resolve, and telling
# someone to check it out is the same kind of advice-that-cannot-work this whole
# change is about. Nothing installs it, since
# only status 0 reaches the download.
resolve_ref_tag() {
    # `|| _rrt_first=$?` rather than a bare call: a non-zero state is the normal
    # answer here, and `set -e` would otherwise abort the whole resolution the
    # first time a spelling came back without a release.
    _rrt_first=0
    release_tag_state "$1" || _rrt_first=$?
    if [ "$_rrt_first" -eq 0 ]; then
        printf '%s\n' "$1"
        return 0
    fi
    # A bare version is the one alternate spelling worth a second request.
    # Already `v`-prefixed, or a branch or a sha, which are not versions:
    # `vmain` is a tag nobody has, so it stays at "no such tag" untried.
    _rrt_second=1
    case "$1" in
        [0-9]*.[0-9]*.[0-9]*)
            _rrt_second=0
            release_tag_state "v$1" || _rrt_second=$?
            ;;
    esac
    if [ "$_rrt_second" -eq 0 ]; then
        printf 'v%s\n' "$1"
        return 0
    fi
    # Either spelling being a real tag means the user named a version that was
    # never released, which is a different thing to be told than a typo.
    if [ "$_rrt_first" -eq 2 ]; then
        printf '%s\n' "$1"
        return 2
    fi
    if [ "$_rrt_second" -eq 2 ]; then
        printf 'v%s\n' "$1"
        return 2
    fi
    return 1
}

# ---- the `vey` alias: one short launch command next to the binary ----
link_alias() {
    # $1 = directory containing BIN_NAME
    target="$1/$BIN_NAME"
    link="$1/$ALIAS_NAME"
    [ -e "$target" ] || return 0
    # `ln -sf` unlinks whatever is at $link first, so it happily destroyed a
    # user's OWN `vey` script sitting in the install dir, with no warning and no
    # way to get it back. Only ever replace something this installer could have
    # put there: a symlink already pointing at our binary (idempotent reinstall),
    # or a dangling symlink (nothing to lose). Anything else is the user's file
    # and is left alone.
    ALIAS_IS_OURS=0
    if [ -L "$link" ]; then
        if [ "$(readlink "$link" 2>/dev/null)" = "$target" ]; then
            ALIAS_IS_OURS=1
            ok "'$ALIAS_NAME' already points at $BIN_NAME"
            return 0
        fi
        if [ ! -e "$link" ]; then
            if ln -sf "$target" "$link" 2>/dev/null; then
                ALIAS_IS_OURS=1
                ok "replaced a broken '$ALIAS_NAME' link -> $BIN_NAME"
            else
                warn "could not link '$ALIAS_NAME' (launch with '$BIN_NAME')"
            fi
            return 0
        fi
        warn "left '$ALIAS_NAME' alone: $link is a symlink to something else ($(readlink "$link" 2>/dev/null)). Remove it yourself if you want '$ALIAS_NAME' to launch $BIN_NAME; meanwhile launch with '$BIN_NAME'."
        return 0
    fi
    if [ -e "$link" ]; then
        warn "left '$ALIAS_NAME' alone: $link already exists and was not created by this installer. Remove it yourself if you want '$ALIAS_NAME' to launch $BIN_NAME; meanwhile launch with '$BIN_NAME'."
        return 0
    fi
    if ln -s "$target" "$link" 2>/dev/null; then
        ALIAS_IS_OURS=1
        ok "linked '$ALIAS_NAME' -> $BIN_NAME"
    else
        warn "could not link '$ALIAS_NAME' (launch with '$BIN_NAME')"
    fi
}

# The comment written directly above the PATH line, so an uninstall can
# recognize its own work in a file the user also edits by hand.
PATH_MARKER="# added by the veyyon installer"

# The exact PATH line this installer writes into $1 for install dir $2.
#
# ONE owner, read by both ensure_on_path (which writes it) and
# remove_path_line_from_rc (which takes it back out). Without a single owner an
# uninstall has to guess at the text install produced, and a guess either leaves
# the line behind forever or deletes a line the user wrote themselves.
#
# The directory is SINGLE-quoted, and that is the whole point of this function.
# It used to be written into a double-quoted string, where the shell expands
# what it finds: an install under a directory containing `$` produced
# `export PATH="/home/a$PATH/bin:$PATH"`, which on the next login expanded
# `$PATH` INSIDE the directory name and put a nonsense entry on PATH — the user
# saw `veyyon: command not found` in a shell whose rc plainly names the right
# directory. A backtick or a backslash in the name is the same class of bug.
# Single quotes suppress all of it; `$PATH` itself stays outside them so it is
# still the expansion it has to be.
#
# A literal single quote in the path is closed, escaped and reopened, which is
# the only way to put one inside single quotes in POSIX sh.
shell_single_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
path_line_for() {
    case "$1" in
        # fish_add_path takes the path as an argument rather than building a
        # string, but an unquoted argument still splits on spaces and globs.
        */config.fish) printf 'fish_add_path %s' "$(shell_single_quote "$2")" ;;
        *) printf 'export PATH=%s:"$PATH"' "$(shell_single_quote "$2")" ;;
    esac
}

# Every rc ensure_on_path might have chosen, across shells. A user who switched
# shells since installing still has the old shell's line, and leaving it is
# leaving a PATH entry pointing at a directory that no longer holds veyyon.
rc_candidates() {
    printf '%s\n' \
        "$HOME/.bashrc" \
        "$HOME/.bash_profile" \
        "$HOME/.bash_login" \
        "$HOME/.profile" \
        "$HOME/.zshrc" \
        "$HOME/.config/fish/config.fish"
}

# Whether a colon-delimited PATH contains one exact directory entry.
#
# A case pattern such as `*":$dir:"*` treats `*`, `?`, and `[` inside $dir as
# pattern syntax. Those are legal filename characters, so an install directory
# such as `/opt/*/bin` could falsely match `/opt/other/bin` and skip PATH setup.
# Peel entries off as strings instead; no pathname expansion or pattern built
# from user input is involved.
path_contains_dir() {
    _pcd_path="${1}:"
    _pcd_want="$2"
    while [ -n "$_pcd_path" ]; do
        _pcd_entry="${_pcd_path%%:*}"
        [ "$_pcd_entry" = "$_pcd_want" ] && return 0
        _pcd_path="${_pcd_path#*:}"
    done
    return 1
}

# ---- ensure the install dir is actually on PATH (binary mode) ----
ensure_on_path() {
    dir="$1"
    path_contains_dir "$PATH" "$dir" && return 0
    # Add to the user's shell rc, idempotently, and announce it.
    rc=""
    case "${SHELL##*/}" in
        zsh) rc="$HOME/.zshrc" ;;
        bash)
            # macOS Terminal.app opens *login* bash shells, which read
            # ~/.bash_profile (then ~/.bash_login, ~/.profile) and NOT ~/.bashrc,
            # so a PATH line written only to ~/.bashrc never takes effect there.
            # Linux terminals open interactive non-login shells that read ~/.bashrc.
            if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
                if [ -f "$HOME/.bash_profile" ]; then rc="$HOME/.bash_profile"
                elif [ -f "$HOME/.bash_login" ]; then rc="$HOME/.bash_login"
                elif [ -f "$HOME/.profile" ]; then rc="$HOME/.profile"
                else rc="$HOME/.bash_profile"
                fi
            else
                rc="$HOME/.bashrc"
            fi
            ;;
        fish) rc="$HOME/.config/fish/config.fish" ;;
        *) rc="$HOME/.profile" ;;
    esac
    line=$(path_line_for "$rc" "$dir")
    # Three distinct outcomes, three distinct messages. Collapsing them (as this
    # did) meant a REINSTALL — where the rc already carries the line — told the
    # user to "add $dir to your PATH" even though it was already configured and
    # all they needed was a new shell. The manual-action warning is now reserved
    # for the case where the installer genuinely could not do it.
    #
    # The "already configured" test matches the WHOLE LINE this installer writes,
    # not the directory as a substring. `grep -Fq "$dir"` matched an rc holding
    # `$HOME/.local/bin2`, or a comment that merely mentions the path, and the
    # installer then skipped the add and reported the directory as configured —
    # so a new shell never had it and "restart your shell" was advice that could
    # not work. Same prefix-substring bug Test-PathContainsDir fixed on Windows.
    # Reaching this point at all means the directory is NOT on the PATH of the
    # shell running the installer, so whatever happens below, the command the
    # closing message names cannot be typed until this shell reloads. The next
    # steps used to open with "1. Launch in any repository: veyyon" regardless,
    # which is the first thing a new user tries and the first thing that fails.
    PATH_NEEDS_RELOAD=1
    PATH_RELOAD_RC="$rc"
    if [ -z "$rc" ]; then
        warn "add $dir to your PATH, then run '$ALIAS_NAME'"
    elif [ -f "$rc" ] && grep -Fqx "$line" "$rc"; then
        ok "$dir is already on PATH in $rc (restart your shell or: source $rc)"
    else
        mkdir -p "$(dir_of "$rc")" 2>/dev/null || true
        printf '\n%s\n%s\n' "$PATH_MARKER" "$line" >> "$rc" \
            && ok "added $dir to PATH in $rc (restart your shell or: source $rc)" \
            || warn "could not write $rc — add $dir to your PATH, then run '$ALIAS_NAME'"
    fi
}

# The command the user should actually type.
#
# `vey` is the short launch alias, but the installer refuses to create it when
# the user already owns that name — and then every closing message told them to
# run `vey` anyway, which runs their tool, not veyyon. One owner, read by every
# closing message, so the advice can never contradict what link_alias decided.
launch_command() {
    if [ "$ALIAS_IS_OURS" = 1 ]; then printf '%s' "$ALIAS_NAME"; else printf '%s' "$BIN_NAME"; fi
}

# The closing block, identical for every install mode. It was pasted three times,
# so a change to the advice had to be made three times or the modes disagreed.
#
# Step 3 used to read "Run system diagnostics: <cmd> plugin doctor". There is no
# `doctor` command, `plugin doctor` reports on plugins alone, and on a fresh
# install it prints three plugin slots all "not created yet" — so the step told a
# new user they were checking their system and then showed them a report about a
# subsystem they had never touched. The install's own doctor already ran, eight
# lines above this. Every step here names a command that exists and does what the
# label says it does.
#
# The commands are padded into a column so the eye can run down them, and the
# padding is dropped on a terminal too narrow to hold it. At 40 columns the
# widest row was 41 characters and wrapped, which turns a three-line table into
# five ragged ones and undoes the alignment the padding existed for. 48 is the
# widest row (`  3. See every command:        veyyon --help`) plus a margin, so
# the column survives everywhere it fits and is abandoned only where it cannot.
print_next_steps() {
    _cmd=$(launch_command)
    _pns_cols=$(term_cols)
    say ""
    say "${C_OK}${C_BOLD}✓ Installation complete.${C_RESET}"
    say ""
    say "Next steps:"
    # The install directory went onto PATH through a shell profile, and a profile
    # is read when a shell starts. THIS shell already started, so the command
    # named below is not a command here yet. Leading with it means the first thing
    # a new user types after a successful install answers "command not found",
    # which reads as a broken install rather than as a shell that has not caught
    # up. When a reload is needed it is a step, numbered like the rest, rather than
    # a parenthetical after the thing it has to precede.
    _pns_n=0
    if [ "$PATH_NEEDS_RELOAD" = 1 ]; then
        if [ -n "$PATH_RELOAD_RC" ]; then
            pns_step "Reload your shell:" "exec \$SHELL -l" "$_pns_cols"
            # Indented under the step it belongs to, and wrapped: a profile path
            # is long, and this line ran off a 40- and a 60-column terminal.
            wrap_line "     " "     " 5 "or, without a new shell: source $PATH_RELOAD_RC"
        else
            pns_step "Reload your shell:" "exec \$SHELL -l" "$_pns_cols"
        fi
    fi
    pns_step "Launch in any repository:" "$_cmd" "$_pns_cols"
    pns_step "Connect API providers:" "$_cmd setup" "$_pns_cols"
    pns_step "See every command:" "$_cmd --help" "$_pns_cols"
}

# One numbered step. The label column is padded so the commands line up, which
# only works while there is room for it: under 48 columns the padded form ran
# past the edge and wrapped mid-command, so there the label and the command are
# separated by a single space instead. `_pns_n` is the caller's counter, since
# whether the reload step exists decides what number everything after it gets.
pns_step() { # label, command, cols
    _pns_n=$((_pns_n + 1))
    if [ "$3" -gt 0 ] && [ "$3" -lt 48 ]; then
        say "  $_pns_n. $1 $2"
        return
    fi
    printf '  %s. %-25s %s\n' "$_pns_n" "$1" "$2"
}

# ---- shell completions (best-effort, loud if unavailable — never silent) ----
completions_dir_for() {
    case "$1" in
        bash) echo "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions" ;;
        zsh)  echo "${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions" ;;
        fish) echo "${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions" ;;
    esac
}

# The filename each shell autoloads for a given command name. Single owner: both
# install_completions and do_uninstall derive every path from this, so the two can
# never disagree about what was written and what must be removed.
completion_file_for() {
    # $1 = shell, $2 = command name (BIN_NAME or ALIAS_NAME)
    case "$1" in
        bash) echo "$2" ;;
        zsh)  echo "_$2" ;;
        fish) echo "$2.fish" ;;
    esac
}

# The file whose presence means bash's user completions directory is autoloaded
# at all. Without the bash-completion package there is no dynamic loader, so a
# file written under it is never read.
BASH_COMPLETION_LOADERS="/usr/share/bash-completion/bash_completion
/etc/bash_completion
/usr/local/share/bash-completion/bash_completion
/opt/homebrew/etc/profile.d/bash_completion.sh"

# Whether the shell will actually LOAD the directory we just wrote into.
# 0 = yes, 1 = no, 2 = cannot tell (that shell is not installed here).
#
# Writing the file is only half the job. zsh's site-functions directory under
# $XDG_DATA_HOME is NOT on the default $fpath on most systems, and bash's user
# completions directory does nothing without the bash-completion loader. The
# installer printed "installed zsh completions" in both cases and the user got
# no tab completion at all, with nothing on screen suggesting why.
completions_dir_is_loaded() {
    _shell="$1"
    _dir="$2"
    case "$_shell" in
        fish)
            # ~/.config/fish/completions is on fish's complete path by
            # construction, so there is nothing to verify.
            return 0
            ;;
        zsh)
            has zsh || return 2
            # A non-interactive zsh reports the compiled-in $fpath plus whatever
            # .zshenv adds. fpath edits conventionally live in .zshrc, which only
            # interactive shells read, and running an interactive shell from an
            # installer can hang, so the rc text is checked as well.
            if zsh -c 'print -rl -- $fpath' 2>/dev/null | grep -Fqx "$_dir"; then
                return 0
            fi
            for _rc in "$HOME/.zshrc" "$HOME/.zshenv" "$HOME/.zprofile"; do
                # Whole-token match, not substring: an rc mentioning
                # "$_dir-other" is a DIFFERENT directory, and treating it as
                # ours would suppress the warning for a dir zsh never loads.
                # `fpath=(/a/b $fpath)` splits on parens, quotes and whitespace.
                if [ -f "$_rc" ] && tr "()=\"' \t" '\n\n\n\n\n\n\n' < "$_rc" | grep -Fqx "$_dir"; then
                    return 0
                fi
            done
            return 1
            ;;
        bash)
            has bash || return 2
            if [ -n "${BASH_COMPLETION_USER_DIR:-}" ]; then
                return 0
            fi
            for _loader in $BASH_COMPLETION_LOADERS; do
                if [ -r "$_loader" ]; then
                    return 0
                fi
            done
            return 1
            ;;
    esac
    return 2
}

# What the user has to do to make an unloaded completions directory load.
completions_enable_hint() {
    case "$1" in
        zsh)  printf 'add  fpath=(%s $fpath)  to ~/.zshrc, above the compinit line' "$2" ;;
        bash) printf 'install your distro'\''s bash-completion package, then open a new shell' ;;
        *)    printf 'open a new shell' ;;
    esac
}

# A sidecar receipt distinguishes files this installer owns from unrelated files
# that happen to use the same name.
#
# A receipt vouches for a FILE, never for a path. The v1 receipt recorded only
# the constant `veyyon-installer-v1`, so it said "this installer owns whatever is
# at this path". Deleting an installed binary by hand left the sidecar behind,
# and the next unrelated file to take that name inherited the ownership: the
# installer would overwrite, and uninstall would delete, a file it never wrote.
#
# v2 records the identity of the artifact it was written for and is accepted only
# while the artifact still matches:
#
#     veyyon-installer-v2
#     <kind> sha256:<64 lowercase hex>
#
# The identity is a sha256 rather than size-plus-inode. Inode numbers are reused
# as soon as the slot is freed, which is exactly the moment this check has to be
# right, and a same-size replacement defeats the size half; a digest defeats
# both. The cost is one hash of the artifact at install and at uninstall, never
# in a loop, on a script that already hashes the same file to verify its
# download.
#
# `kind` is `file` for a regular file, whose identity is its bytes, or `link` for
# a symlink, whose identity is the TARGET STRING it holds. A symlink's own
# content IS that string, and it is the whole of what the installer created. The
# destination is deliberately not hashed: an older source install linked at a git
# checkout that changed on every `git pull`, so hashing through the link would
# mark such an install foreign the first time it advanced. Those links still have
# to be recognized here, because this installer has to be able to replace one.
owner_marker_for() {
    _owner_path="$1"
    printf '%s/.%s.veyyon-owner' "$(dirname "$_owner_path")" "$(basename "$_owner_path")"
}

# The identity line for the artifact currently at `$1`, or nothing.
#
# Fails rather than guessing when the digest cannot be computed: no sha256 tool,
# an unreadable file, a path that is neither a symlink nor a regular file. Every
# caller treats that failure as "not ours", so an ownership question this cannot
# answer is answered NO.
artifact_identity() {
    _identity_path="$1"
    if [ -L "$_identity_path" ]; then
        _identity_target=$(readlink "$_identity_path" 2>/dev/null) || return 1
        _identity_hash=$(sha256_of_text "$_identity_target") || return 1
        printf 'link sha256:%s' "$_identity_hash"
        return 0
    fi
    [ -f "$_identity_path" ] || return 1
    _identity_hash=$(sha256_of_file "$_identity_path") || return 1
    printf 'file sha256:%s' "$_identity_hash"
}

# The identity a v2 receipt records for `$1`. Fails when there is no sidecar, or
# when the sidecar is a v1 receipt, which records no identity at all.
#
# The recorded line is returned verbatim and compared as a string. A truncated or
# corrupted sidecar therefore cannot match a computed identity, so it reads as
# "not ours" without needing a second validator here.
owner_receipt_identity() {
    _receipt_file=$(owner_marker_for "$1")
    [ -f "$_receipt_file" ] || return 1
    awk '
        NR == 1 && $0 != "veyyon-installer-v2" { exit 1 }
        NR == 2 { print; exit }
    ' "$_receipt_file" 2>/dev/null
}

artifact_has_owner_receipt() {
    _receipt_recorded=$(owner_receipt_identity "$1") || return 1
    [ -n "$_receipt_recorded" ] || return 1
    _receipt_actual=$(artifact_identity "$1") || return 1
    [ "$_receipt_recorded" = "$_receipt_actual" ]
}

# Whether `$1` carries a v1 receipt: the pre-identity format, which vouched for
# the path alone. It proves an installer once wrote SOMETHING here and nothing
# about what is here now, so it never decides ownership on its own. It exists so
# the gates below can say why they refused.
artifact_has_legacy_owner_receipt() {
    _legacy_receipt=$(owner_marker_for "$1")
    [ -f "$_legacy_receipt" ] && grep -Fqx 'veyyon-installer-v1' "$_legacy_receipt" 2>/dev/null
}

# Writing a receipt REQUIRES the identity. A receipt that recorded no identity
# would be a v1 receipt under a v2 name, and would reopen the hole for that
# artifact permanently. Callers already treat a failure here as fatal for the
# binary and as a warning for completions.
mark_artifact_owned() {
    _owner_marker=$(owner_marker_for "$1")
    _owner_identity=$(artifact_identity "$1") || return 1
    _owner_tmp="$_owner_marker.$$"
    printf '%s\n%s\n' 'veyyon-installer-v2' "$_owner_identity" > "$_owner_tmp" || return 1
    mv -f "$_owner_tmp" "$_owner_marker" || { rm -f "$_owner_tmp"; return 1; }
}

# Both halves of the ownership record, because a pending receipt left behind by a
# removed artifact is the same orphan hazard the v1 receipt was: it would vouch
# for a name after the file it described is gone.
remove_owner_receipt() {
    _owner_marker=$(owner_marker_for "$1")
    rm -f "$_owner_marker" 2>/dev/null || true
    clear_artifact_ownership_pending "$1"
}

# ---- the in-flight half of a receipt ----
#
# A receipt can only be written AFTER the file it describes is in place, so
# between the move and the write there is a moment when the binary on disk is
# ours and nothing on disk says so. Anything that ends the installer in that
# moment used to be PERMANENT: the sidecar still described the binary just
# retired, so every later install refused to replace "somebody else's file" and
# every later uninstall left it behind, with no remedy but hand surgery. A
# reinstall could not repair it either, which is what made it a dead end rather
# than a nuisance.
#
# The pending receipt is written BEFORE the swap and records the identity of the
# file about to be installed, so throughout the window one of the two sidecars
# vouches for whatever is at the path: the real receipt for the outgoing file,
# the pending one for the incoming file. It is removed once the real receipt
# lands. A pending receipt that outlives its swap is harmless rather than
# dangerous — it can only ever vouch for bytes this installer itself staged and
# verified — which is why removing it is best effort while recovery is not.
# Mirrors Get-PendingOwnerMarkerPath and its neighbours in install.ps1.
owner_pending_marker_for() {
    printf '%s.pending' "$(owner_marker_for "$1")"
}

pending_owner_receipt_identity() {
    _pending_receipt=$(owner_pending_marker_for "$1")
    [ -f "$_pending_receipt" ] || return 1
    awk '
        NR == 1 && $0 != "veyyon-installer-v2" { exit 1 }
        NR == 2 { print; exit }
    ' "$_pending_receipt" 2>/dev/null
}

artifact_has_pending_owner_receipt() {
    _pending_recorded=$(pending_owner_receipt_identity "$1") || return 1
    [ -n "$_pending_recorded" ] || return 1
    _pending_actual=$(artifact_identity "$1") || return 1
    [ "$_pending_recorded" = "$_pending_actual" ]
}

# Declare the identity about to be installed at $1. $2 is computed from the
# STAGED file while it is still staged, because once the swap has begun there may
# be no opportunity left to compute anything.
mark_artifact_ownership_pending() {
    _pending_marker=$(owner_pending_marker_for "$1")
    [ -n "$2" ] || return 1
    _pending_tmp="$_pending_marker.$$"
    printf '%s\n%s\n' 'veyyon-installer-v2' "$2" > "$_pending_tmp" || return 1
    mv -f "$_pending_tmp" "$_pending_marker" || { rm -f "$_pending_tmp"; return 1; }
}

clear_artifact_ownership_pending() {
    rm -f "$(owner_pending_marker_for "$1")" 2>/dev/null || true
}

# Close the window the pending receipt held open: write the real receipt, then
# drop the pending one.
#
# Deliberately does NOT die. It runs only after a swap has already succeeded, and
# the binary at $1 is installed and runnable whatever happens here, so aborting
# would deny an on-disk install its PATH line, its alias, its completions and its
# doctor self-test. When the real receipt cannot be written the pending one is
# left in place, so ownership is still recorded and the next install repairs it.
complete_artifact_ownership() {
    if mark_artifact_owned "$1"; then
        clear_artifact_ownership_pending "$1"
        return 0
    fi
    warn "installed $1 but could not record its ownership (check permissions, and that a sha256 tool is available)"
    warn "    $(owner_pending_marker_for "$1") still vouches for it, so a later install or uninstall will recognize it"
}

legacy_completion_is_ours() {
    _completion_path="$1"; _completion_shell="$2"
    [ -f "$_completion_path" ] || return 1
    case "$_completion_shell" in
        bash) grep -Eq 'complete .*(^|[[:space:]])veyyon([[:space:]]|$)' "$_completion_path" 2>/dev/null ;;
        zsh) grep -Eq '^#compdef([[:space:]]+[^[:space:]]+)*[[:space:]]+veyyon([[:space:]]|$)|^#compdef[[:space:]]+veyyon([[:space:]]|$)' "$_completion_path" 2>/dev/null ;;
        fish) grep -Eq '^complete[[:space:]]+-c[[:space:]]+veyyon([[:space:]]|$)' "$_completion_path" 2>/dev/null ;;
        *) return 1 ;;
    esac
}

# A completion file needs no authoritative-mismatch rule, because its fallback is
# already an identity check: `legacy_completion_is_ours` reads the file and
# accepts only a Veyyon registration for that shell. A stranger's file inheriting
# an orphaned receipt fails both halves. This is also what keeps `veyyon update`
# from breaking completions it legitimately regenerates: the rewritten file no
# longer matches its receipt, but it is still unmistakably ours by content.
completion_artifact_is_ours() {
    artifact_has_owner_receipt "$1" || legacy_completion_is_ours "$1" "$2"
}

# Existing binary ownership is receipt-first. The two legacy forms are exact
# artifacts old installers created: the source launcher link, or a canonical
# binary paired with this installer's exact `vey -> veyyon` alias.
binary_artifact_is_ours() {
    _binary_path="$1"
    artifact_has_owner_receipt "$_binary_path" && return 0
    # An install or an update cut off between placing the binary and recording it
    # left the file it staged at this path, and a pending receipt describing it.
    # Those bytes are ours on the same proof the real receipt carries, and this is
    # consulted BEFORE the mismatch rule below because in exactly that case the
    # real receipt still describes the binary that was retired.
    artifact_has_pending_owner_receipt "$_binary_path" && return 0
    # A v2 receipt that does NOT match is this installer's own record that the
    # file it wrote here is gone, so it settles the question and the structural
    # evidence below is not consulted. Falling through would undo the fix: the
    # `vey -> veyyon` symlink survives any replacement of the file beside it, so
    # it would hand ownership of a stranger's file straight back.
    owner_receipt_identity "$_binary_path" >/dev/null 2>&1 && return 1
    if [ -L "$_binary_path" ]; then
        [ "$(readlink "$_binary_path" 2>/dev/null)" = "$(src_dir)/packages/coding-agent/scripts/$BIN_NAME" ] && return 0
    fi
    alias_in_dir_is_ours "$(dirname "$_binary_path")"
}

# Why a refusal happened, for the gates that have to explain themselves. An
# ownership question the installer could not decide must never resolve to "yes",
# but it must not be reported as "this is somebody else's file" either.
binary_refusal_reason() {
    if ! have_sha256_tool; then
        printf 'no sha256 tool (sha256sum/shasum) is available, so its ownership receipt cannot be checked; install coreutils or perl, then re-run'
    elif owner_receipt_identity "$1" >/dev/null 2>&1; then
        # "it has changed" is a claim about the FILE, and it must not be made when
        # the file merely could not be read. An unreadable binary is an ownership
        # question with no answer rather than evidence of tampering, and its remedy
        # is different.
        if artifact_identity "$1" >/dev/null 2>&1; then
            printf 'it has changed since this installer wrote it, so the file there now is not the one it installed'
        else
            printf 'it carries this installer'"'"'s ownership receipt but could not be read to check against it; make it readable, then re-run'
        fi
    elif artifact_has_legacy_owner_receipt "$1"; then
        printf 'its ownership receipt predates recorded file identity and cannot be confirmed against the file that is there now'
    else
        printf 'it was not created by this installer'
    fi
}

binary_path_is_replaceable() {
    [ ! -e "$1" ] && [ ! -L "$1" ] && return 0
    binary_artifact_is_ours "$1"
}

install_completions() {
    bin="$1"
    "$bin" completions --help >/dev/null 2>&1 || {
        warn "this build has no 'completions' command yet — skipping (shell completions not installed)"
        return 0
    }
    for sh in bash zsh fish; do
        out=$(completions_dir_for "$sh")
        [ -n "$out" ] || continue
        mkdir -p "$out" 2>/dev/null || continue
        name=$(completion_file_for "$sh" "$BIN_NAME")
        # The generated script BINDS the alias as well as the binary name
        # (`complete -F _veyyon veyyon vey`, `#compdef veyyon vey`, ...), so
        # skipping only the alias FILE still left our completions attached to a
        # `vey` the user owns. Ask the binary not to bind it at all.
        alias_flag=""
        [ "$ALIAS_IS_OURS" = 1 ] || alias_flag="--no-alias"
        # Generate to a temp first, then move into place: a completion file is
        # sourced by the shell at startup, so a half-written one (disk full, the
        # install killed mid-write) breaks every new shell the user opens. The
        # binary path gets the same treatment in finalize_binary.
        tmp="$out/.$name.$$"
        if "$bin" completions "$sh" $alias_flag > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
            if [ -e "$out/$name" ] && ! completion_artifact_is_ours "$out/$name" "$sh"; then
                rm -f "$tmp"
                warn "left $out/$name alone (not created by this installer)"
                continue
            fi
            if ! mv -f "$tmp" "$out/$name"; then
                rm -f "$tmp"
                warn "could not install $sh completions (skipped)"
                continue
            fi
            mark_artifact_owned "$out/$name" || warn "could not record ownership of $out/$name"
            ok "installed $sh completions"
            # A written file that the shell never reads is not a working
            # completion, so say so here rather than letting the user discover
            # it by pressing Tab and getting nothing.
            loaded=0
            completions_dir_is_loaded "$sh" "$out" || loaded=$?
            if [ "$loaded" = 1 ]; then
                warn "$sh does not load $out, so those completions do nothing yet"
                warn "    fix: $(completions_enable_hint "$sh" "$out")"
            fi
            # bash and fish autoload a completion file by the command name being
            # completed, so the `vey` alias needs its own file or it gets nothing
            # (zsh needs none: the generated script's `#compdef` line names both).
            alias_name=$(completion_file_for "$sh" "$ALIAS_NAME")
            if [ -n "$alias_name" ] && [ "$sh" != "zsh" ] && [ "$ALIAS_IS_OURS" = 1 ]; then
                if [ -e "$out/$alias_name" ] && ! completion_artifact_is_ours "$out/$alias_name" "$sh"; then
                    warn "left $out/$alias_name alone (not created by this installer)"
                elif cp -f "$out/$name" "$out/$alias_name" 2>/dev/null; then
                    mark_artifact_owned "$out/$alias_name" || warn "could not record ownership of $out/$alias_name"
                    ok "installed $sh completions for '$ALIAS_NAME'"
                else
                    warn "could not install $sh completions for '$ALIAS_NAME' (tab completion for '$ALIAS_NAME' unavailable)"
                fi
            fi
        else
            # Remove the empty/partial file and say so: this function's contract is
            # best-effort but never silent, so a failed shell must be visible.
            rm -f "$tmp" 2>/dev/null || true
            warn "could not generate $sh completions (skipped)"
        fi
    done
}

# Where a command name actually resolves from, or "" when it is not on PATH.
# Compared by DIRECTORY rather than by full path: the alias is a symlink to the
# binary beside it, so the two names legitimately resolve to different files in
# the same directory, and comparing dirs avoids needing a portable realpath.
# Uses parameter expansion rather than `dirname`: doctor must keep working when
# PATH is minimal or misconfigured, which is exactly the situation it exists to
# diagnose, and forking an external for a string operation would fail there.
dir_of() {
    case "$1" in
        */*) d="${1%/*}"; [ -n "$d" ] || d="/"; printf '%s' "$d" ;;
        *)   printf '%s' "." ;;
    esac
}

resolved_dir_for() {
    p=$(command -v "$1" 2>/dev/null) || return 1
    [ -n "$p" ] || return 1
    dir_of "$p"
}

# Report whether `$1` on PATH is the copy we just installed into $2.
# A stale copy earlier on PATH (an old `bun add -g` global, a distro package, a
# previous manual install) silently wins every future invocation, so this is
# checked and reported LOUDLY rather than assumed from mere presence on PATH.
check_not_shadowed() {
    name="$1"; want_dir="$2"
    got_dir=$(resolved_dir_for "$name") || {
        warn "'$name' not on PATH yet (restart your shell, or add $want_dir to PATH)"
        return 0
    }
    if [ "$got_dir" = "$want_dir" ]; then
        ok "'$name' on PATH resolves to this install"
    else
        warn "'$name' on PATH resolves to $got_dir/$name, NOT the copy just installed in $want_dir — that older copy shadows this one and will keep running instead. Remove it, or put $want_dir earlier in PATH."
    fi
}

# Pull the semver out of a `--version` line ("veyyon/1.0.37" -> "1.0.37").
# Prints nothing and returns 1 when the line carries no x.y.z token, so a
# format change is visible as a failed check rather than a silent pass.
version_from_output() {
    for tok in $1; do
        cand="${tok##*/}"
        case "$cand" in
            [0-9]*.[0-9]*.[0-9]*) printf '%s' "$cand"; return 0 ;;
        esac
    done
    return 1
}

# Require a staged release binary to identify as the release being installed.
#
# The checksum proves only that the downloaded bytes match the published asset.
# It cannot catch a release that attached an older, otherwise valid executable.
# This gate runs while the old executable is still in place, so a bad release
# costs only the installer-owned staging file.
require_release_version() {
    _rrv_bin="$1"; _rrv_tag="$2"; _rrv_phase="${3:-downloaded}"
    if _rrv_out=$("$_rrv_bin" --version); then
        :
    else
        _rrv_status=$?
        die "the $_rrv_phase $BIN_NAME did not report its version: \`$_rrv_bin --version\` exited $_rrv_status"
    fi
    _rrv_got=$(version_from_output "$_rrv_out") \
        || die "could not read a version from \`$_rrv_bin --version\` output: $_rrv_out"
    _rrv_want="${_rrv_tag#v}"
    if [ "$_rrv_got" = "$_rrv_want" ]; then
        ok "downloaded binary reports the $_rrv_tag release version"
    else
        die "the $_rrv_phase $BIN_NAME reports $_rrv_got but the $_rrv_tag release was requested — refusing to replace the existing executable"
    fi
}

# ---- post-install self-check: prove the thing actually runs ----
# $2 (optional) is the release tag that was installed. When given, the binary
# must report exactly that version.
# Prove the native addon loads, not just that the binary starts.
#
# `--version` is served entirely by the JS entry point: it succeeds on an
# install whose native addon is missing, staged for the wrong architecture, or
# built against a libc this machine does not have. The user then gets a clean
# "doctor: veyyon runs" and a failure on their FIRST real command, which is the
# exact shape of the musl case the preflight check exists to catch and cannot
# catch for every cause. `grep` is the cheapest command that goes through the
# native walker and returns a result we can check: about 130ms more than
# --version, against a file this function writes and knows the contents of.
#
# $2 names the phase, because this runs twice on a binary install and the two
# runs answer different questions. The first is a PREFLIGHT on the still-staged
# download: it fails before the binary is moved into place, before the `vey`
# alias is linked, before the shell profile is edited and before any completion
# file is written, so a release with no build for this platform leaves the
# system exactly as it was. The second is the post-install self-check, which
# proves the binary works from where it now lives. Only the first can prevent
# the mess; only the second can prove the finished install is good.
doctor_natives() {
    _dn_bin="$1"; _dn_phase="${2:-installed}"
    # An older build with no `grep` subcommand is not a broken install, so probe
    # for it the way install_completions probes for `completions`.
    "$_dn_bin" grep --help >/dev/null 2>&1 || {
        warn "this build has no 'grep' command — skipping the native addon self-test"
        return 0
    }
    _dn_dir="${TMPDIR:-/tmp}/veyyon-doctor.$$"
    mkdir -p "$_dn_dir" || {
        warn "could not create $_dn_dir — skipping the native addon self-test"
        return 0
    }
    printf 'veyyon-native-self-test\n' > "$_dn_dir/probe.txt" || {
        rm -rf "$_dn_dir"
        warn "could not write into $_dn_dir — skipping the native addon self-test"
        return 0
    }
    _dn_out=$("$_dn_bin" grep veyyon-native-self-test "$_dn_dir" 2>&1)
    _dn_status=$?
    rm -rf "$_dn_dir"
    if [ "$_dn_status" -ne 0 ]; then
        die "the $_dn_phase $BIN_NAME starts but cannot run a search: \`$BIN_NAME grep\` exited $_dn_status. The native addon did not load. This is usually a platform mismatch (a musl system, or an architecture the release does not build). No prebuilt binary works here, so $MANUAL_BUILD. Output was: $_dn_out"
    fi
    case "$_dn_out" in
        *probe.txt*) ok "native addon loads ($_dn_phase) — search returned the expected match" ;;
        *) die "$BIN_NAME ran a search but did not find a file it was pointed at. The install is not usable. Output was: $_dn_out" ;;
    esac
}

doctor() {
    bin="$1"; want_tag="${2:-}"
    say ""
    say "doctor:"
    # stderr is KEPT, in its own file rather than merged. The one line the system
    # writes about why an executable will not start (a missing shared library, a
    # bad interpreter, a permission refusal) is the entire diagnosis, and sending
    # it to /dev/null left the user with "`veyyon --version` failed" and nothing
    # to act on. Separate rather than merged because `version_from_output` parses
    # this output for a semver, and a warning on stderr carrying digits would
    # otherwise be read as the version.
    # Built from shell variables, not `mktemp`: doctor runs when PATH may be
    # unusable (that is one of the states it exists to report), and a doctor that
    # needs an external command to say what is wrong fails before it can speak.
    # `rm` and `read` are reached through PATH too, so both are allowed to fail
    # quietly here: the worst case is one empty file left in the temp directory
    # on a machine whose PATH is already broken, and that is a far better outcome
    # than doctor dying with `rm: not found` instead of saying what is wrong.
    _doctor_err="${TMPDIR:-/tmp}/veyyon-doctor-err.$$"
    if ver=$("$bin" --version 2>"$_doctor_err"); then
        rm -f "$_doctor_err" 2>/dev/null || :
        ok "$BIN_NAME runs — $ver"
    else
        _doctor_status=$?
        _doctor_why=""
        while IFS= read -r _doctor_line; do
            _doctor_why="${_doctor_why}${_doctor_why:+ }${_doctor_line}"
        done < "$_doctor_err" 2>/dev/null
        rm -f "$_doctor_err" 2>/dev/null || :
        if [ -n "$_doctor_why" ]; then
            die "$BIN_NAME did not run after install: \`$bin --version\` exited $_doctor_status. It said: $_doctor_why"
        fi
        die "$BIN_NAME did not run after install: \`$bin --version\` exited $_doctor_status and printed nothing."
    fi
    # The checksum proved the bytes match the published asset; this proves the
    # published asset is the version the release claims. A release that uploaded
    # the wrong binary for its tag, or a stale cached download, otherwise
    # installs "successfully" and silently runs the wrong version forever. The
    # self-updater enforces the same gate before keeping a swapped-in binary.
    if [ -n "$want_tag" ]; then
        want="${want_tag#v}"
        got=$(version_from_output "$ver") || die "could not read a version from \`$bin --version\` output: $ver"
        if [ "$got" = "$want" ]; then
            ok "reported version matches the $want_tag release"
        else
            die "installed $BIN_NAME reports $got but the $want_tag release was requested — the release may have published a mismatched binary. The file at $bin is NOT the version you asked for; re-run the installer or pin with --ref."
        fi
    fi
    doctor_natives "$bin"
    # Both names are checked: a user who types `veyyon` and a user who types the
    # documented `vey` must each reach the binary that was just installed.
    bin_dir=$(dir_of "$bin")
    check_not_shadowed "$BIN_NAME" "$bin_dir"
    # ...but only when the alias is ours. If link_alias declined because the user
    # already has their own `vey`, the shadow check would report that THEIR
    # command "shadows the copy just installed" and tell them to delete it — for
    # an alias this installer deliberately never created. link_alias already said
    # the true thing; saying a contradictory one right after is worse than
    # silence, so restate it instead.
    if [ "$ALIAS_IS_OURS" = 1 ]; then
        check_not_shadowed "$ALIAS_NAME" "$bin_dir"
    else
        ok "'$ALIAS_NAME' is not ours — launch with '$BIN_NAME'"
    fi
}

# A staging path in the install dir that no concurrent installer can collide on.
#
# Both staging paths used to be fixed names (`.veyyon.download`, `.veyyon.local`),
# so two installers running at once wrote the SAME file: one truncated the
# other's partial download mid-transfer, and whichever finished first had its
# bytes replaced under it before the checksum ran. Worse, each process installs
# an EXIT trap removing that path, so the first to finish deleted the second's
# staging file out from under it. $$ makes the path per-process; the binary
# updater keeps its temp unique for exactly the same reason.
#
# It stays inside the install dir on purpose: finalize_binary renames it into place,
# and a rename is only atomic within one filesystem.
staging_path() {
    printf '%s/.%s.%s.%s' "$(install_dir)" "$BIN_NAME" "$1" "$$"
}

# Remove staging files left behind by an install that was killed.
#
# The EXIT/INT/TERM trap cleans up a Ctrl-C, but nothing survives SIGKILL or a
# power loss, and until now only `--uninstall` ever swept them. Each staging file
# is a full copy of the binary (~100 MB), so a user whose install kept getting
# killed accumulated hundreds of megabytes of hidden files in their install
# directory with nothing on screen to explain them, and no command short of
# uninstalling to reclaim it.
#
# A staging file whose pid is still ALIVE belongs to a concurrent installer and is
# never touched: $$ in staging_path exists precisely so two installers do not
# share a path, and sweeping a live one would delete the other process's partial
# download out from under it — the exact bug that made the paths per-process.
# Removing files is a visible change to a directory the user owns, so every
# removal is announced (Law 10: no quiet cleanup).
sweep_stale_staging() {
    for _ss_path in "$(install_dir)/.$BIN_NAME.download."* "$(install_dir)/.$BIN_NAME.local."*; do
        [ -e "$_ss_path" ] || continue
        _ss_pid=${_ss_path##*.}
        # Only the two phases staging_path writes belong to this installer.
        # A numeric suffix alone is not ownership; foreign phases survive.
        case "$_ss_pid" in
            "" | *[!0-9]*) continue ;;
        esac
        if pid_is_running "$_ss_pid"; then
            say "leaving $_ss_path alone — another installer (pid $_ss_pid) is using it"
            continue
        fi
        rm -f "$_ss_path" && ok "removed $_ss_path left by an interrupted install (pid $_ss_pid)"
    done
}

# Whether a process with this pid exists, regardless of who owns it.
#
# NOT `kill -0`: that reports EPERM for a process this user may not signal, which
# is indistinguishable from ESRCH through the exit status alone. A pid can be
# recycled onto another user's process, and reading "cannot signal it" as "it is
# gone" is what would let the sweep delete a live installer's download. `ps -p` is
# POSIX and answers for every process on both Linux and macOS.
#
# With no `ps` at all the answer is unknowable, so it fails SAFE and says the pid
# is running: refusing to reclaim a stale file costs disk, and the alternative
# costs another process its download.
pid_is_running() {
    if has ps; then
        ps -p "$1" >/dev/null 2>&1
        return $?
    fi
    return 0
}

# Whether the middle of a `<binary><middle>.<new|bak>` name is one `veyyon update`
# writes. $1 carries its leading dot, or is empty for the undecorated name.
#
# The updater gives every attempt its own pathname so two concurrent updates
# cannot truncate each other's download, so both names carry that attempt's
# UUID: `veyyon.<uuid>.new` and `veyyon.<uuid>.bak`. The sweeps that reclaim
# them were written against the names used BEFORE that change — a fixed
# `veyyon.new` and a dot-separated-numeric `veyyon.<timestamp>.<pid>.bak` — and
# were never updated, so they matched neither shape actually on disk and an
# uninstall reported success while leaving ~150MB behind per orphaned attempt.
# Both spellings are recognized, because the older ones are still on machines
# that ran an older release. Anything else is not ours, which is what keeps a
# `veyyon.mine.bak` somebody saved by hand from being swept.
#
# Mirrors Test-UpdateAttemptLeftover in install.ps1 and the classification in
# sweepStaleBackups in packages/coding-agent/src/cli/update-cli.ts. All three have
# to agree, or a file is reclaimed on one platform and left on another.
update_attempt_middle_is_ours() {
    # Case patterns built from unquoted expansions: the brackets have to reach the
    # pattern matcher as patterns, so these cannot be quoted. The version and
    # variant nibbles are pinned to what crypto.randomUUID() produces (v4), which
    # is what keeps this from degenerating into "anything hex with hyphens in it".
    _uam_h1='[0-9a-fA-F]'
    _uam_h3="$_uam_h1$_uam_h1$_uam_h1"
    _uam_h4="$_uam_h3$_uam_h1"
    _uam_h8="$_uam_h4$_uam_h4"
    _uam_h12="$_uam_h8$_uam_h4"
    case "$1" in
        ("") return 0 ;;
        (.$_uam_h8-$_uam_h4-[1-8]$_uam_h3-[89abAB]$_uam_h3-$_uam_h12) return 0 ;;
        (*[!0-9.]*) return 1 ;;
        (.*) return 0 ;;
    esac
    return 1
}

# ---- place a downloaded binary at its final path, atomically ----
# Refuses an empty download, makes the file executable BEFORE the move (so it is
# never visible non-executable at the final path), then moves it into place.
# `mv` within one filesystem is atomic and preserves the mode set here; the temp
# file lives in the same dir as the destination so the move never crosses a
# filesystem boundary. args: <tmpfile> <dest>
finalize_binary() {
    # $3 is what the user should DO about an empty staged file. It differs by
    # caller: a truncated download is retried, an empty local build is rebuilt.
    # The message used to say "downloaded binary" and blame the network for both,
    # which sent a --local user chasing a problem they never had.
    tmp="$1"; dest="$2"; empty_hint="$3"
    [ -s "$tmp" ] || die "the binary staged at $tmp is empty — refusing to install; $empty_hint"
    # The identity of the file being installed, taken while it is still staged.
    # Everything below needs it before the move: the pending receipt has to be on
    # disk BEFORE the binary is, and once the swap has begun there may be no
    # chance left to compute anything at all.
    _finalize_incoming=$(artifact_identity "$tmp") || {
        rm -f "$tmp"
        die "could not compute the sha256 of the binary staged at $tmp, so this install could not be recorded as ours — retry, or $MANUAL_BUILD"
    }
    if [ -e "$dest" ] || [ -L "$dest" ]; then
        # Already byte-identical to what is being installed. There is nothing to
        # replace, so nothing to refuse: an ownership gate here would be refusing
        # to install a file that IS the one being installed. Re-stamping is what
        # repairs an install whose receipt was lost mid-swap.
        if [ "$(artifact_identity "$dest" 2>/dev/null)" = "$_finalize_incoming" ]; then
            rm -f "$tmp"
            ok "$dest is already this exact binary — left it in place"
            complete_artifact_ownership "$dest"
            return 0
        fi
        if ! binary_artifact_is_ours "$dest"; then
            if [ "$FORCE" != 1 ]; then
                rm -f "$tmp"
                die "refusing to replace $dest because $(binary_refusal_reason "$dest").
The ownership record consulted is $(owner_marker_for "$dest").
Move $dest aside and re-run, or re-run with --force to have the installer move it aside for you (nothing is deleted)."
            fi
            # --force displaces, it does not destroy. The file goes to a name no
            # sweep and no uninstall touches, and that name is printed, because
            # taking a filename away from a file the installer cannot account for
            # is the user's decision and they have to be able to undo it.
            _finalize_unowned="$dest.unowned.$$"
            warn "--force: $dest $(binary_refusal_reason "$dest")"
            mv -f "$dest" "$_finalize_unowned" || die "could not move $dest aside to $_finalize_unowned"
            warn "moved it aside to $_finalize_unowned (nothing was deleted)"
        fi
    fi
    chmod +x "$tmp" || die "could not make $tmp executable"
    # The swap begins here, so the incoming identity goes on disk first.
    mark_artifact_ownership_pending "$dest" "$_finalize_incoming" ||
        die "could not record the pending ownership of $dest — check permissions and re-run the installer"
    mv -f "$tmp" "$dest" || {
        clear_artifact_ownership_pending "$dest"
        die "could not move binary into place at $dest"
    }
    complete_artifact_ownership "$dest"
}

# ---- checksum verification (fail closed on mismatch) ----
# Read a `.sha256` sidecar body ("<64-hex>  <filename>") to its lowercased
# digest, printing nothing when the body holds no digest.
#
# Strict on purpose, and deliberately identical to the TypeScript owner in
# packages/natives/src/sha256-sidecar.ts: a token that is not exactly 64 hex
# characters means the response is not a checksum at all (an HTML error page, a
# rate-limit body, a sidecar truncated by a dropped connection). Passing that
# token through would compare the real digest against "<!doctype" and report a
# checksum mismatch, which tells the user their download is corrupt when the
# download was fine and the sidecar was not. Lowercasing is what lets a sidecar
# written in uppercase hex verify a byte-identical file, which a raw string
# comparison would call tampering.
parse_sha256_sidecar() {
    printf '%s' "$1" | awk '
        NR == 1 {
            if ($1 ~ /^[0-9a-fA-F]{64}$/) print tolower($1)
            exit
        }'
}

# Whether this machine can compute a sha256 at all. Both the download integrity
# gate and the ownership receipts need one, so a machine that cannot verify a
# download also cannot decide who owns a file, and both say so rather than
# proceeding on a guess.
have_sha256_tool() {
    has sha256sum || has shasum
}

# Lowercased sha256 of stdin, or a failure. One tool dispatch for the whole
# script: the download gate below and the ownership receipts above both read it,
# so the two can never disagree about what a digest is.
#
# The digest is pulled back out with parse_sha256_sidecar because `sha256sum`
# emits exactly the sidecar shape ("<64-hex>  <name>"), which means the strict
# 64-hex check already lives in one place. A tool that printed a diagnostic
# instead of a digest therefore fails here rather than returning a non-digest.
sha256_of_stdin() {
    if has sha256sum; then _sha_output=$(sha256sum 2>/dev/null)
    elif has shasum; then _sha_output=$(shasum -a 256 2>/dev/null)
    else return 1
    fi
    _sha_digest=$(parse_sha256_sidecar "$_sha_output")
    [ -n "$_sha_digest" ] || return 1
    printf '%s' "$_sha_digest"
}

sha256_of_file() {
    sha256_of_stdin < "$1"
}

sha256_of_text() {
    printf '%s' "$1" | sha256_of_stdin
}

verify_sha256() {
    file="$1"; expected="$2"
    have_sha256_tool || die "no sha256 tool (sha256sum/shasum) available — cannot verify download integrity (use --no-verify to override)"
    actual=$(sha256_of_file "$file") || die "could not compute the sha256 of $file — refusing to install an unverified binary"
    # Both sides lowercased: hex case carries no meaning, and a case-sensitive
    # comparison reports a byte-identical file as a tampered binary. sha256_of_file
    # already lowercases its side.
    expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
    [ "$actual" = "$expected" ] || die "checksum mismatch (expected $expected, got $actual) — refusing to install a tampered binary"
    ok "verified sha256"
}

# Verify a downloaded release binary against its published .sha256 sidecar.
# Fail closed: a missing or unparseable sidecar refuses the install unless
# --no-verify was passed (only needed for old pre-sidecar releases).
# args: <file> <binary_url> <asset_name> <release_tag>
verify_release_binary() {
    file="$1"; url="$2"; asset="$3"; tag="$4"
    if [ "$VERIFY" -ne 1 ]; then
        warn "checksum verification skipped (--no-verify)"
        return 0
    fi
    if sum=$(curl -fsSL $CURL_RETRY --connect-timeout 10 --max-time 30 "${url}.sha256" 2>/dev/null); then
        expected=$(parse_sha256_sidecar "$sum")
        [ -n "$expected" ] || die "published checksum for $asset is empty/unparseable — refusing to install (pass --no-verify to override)"
        verify_sha256 "$file" "$expected"
    else
        die "no published checksum for $asset ($tag) — refusing to install unverified. Current releases publish .sha256 sidecars; for an old pre-sidecar release, pass --no-verify to override."
    fi
}

# ---- uninstall ----
# Take the PATH line back out of an rc, and nothing else.
#
# Uninstall used to leave it behind forever: every install appended
# `export PATH="<dir>:$PATH"` to a shell rc and no uninstall ever removed it, so
# a user who installed and removed veyyon kept a PATH entry pointing at a
# directory veyyon no longer occupies, plus a comment claiming an installer put
# it there.
#
# It is surgical on purpose. This is a file the user also edits by hand, so only
# the EXACT line path_line_for produces is dropped, along with the marker
# comment when it sits directly above it. A line the user wrote themselves, even
# one naming the same directory, is left alone.
#
# Rewrites through `cat > "$rc"` rather than `mv`: an rc is very often a symlink
# into a dotfiles repo, and `mv` would replace that symlink with a regular file.
# Returns 0 only when something was actually removed.
# Every spelling of the PATH line an install of veyyon may have written, newest
# first. Uninstall has to match all of them.
#
# `path_line_for` changed once, to single-quote the directory so a name
# containing `$` stops expanding when the rc is sourced. Matching only the
# CURRENT spelling would mean an install made before that change is
# unrecognisable to the uninstall that comes after it: the line stays in the rc
# forever, pointing at a directory that no longer holds veyyon, which is the
# exact complaint that started this work. The old spelling is quoted here rather
# than reconstructed, because it is a historical fact and not a rule.
path_line_candidates_for() {
    path_line_for "$1" "$2"
    printf '\n'
    case "$1" in
        */config.fish) printf 'fish_add_path %s\n' "$2" ;;
        *) printf 'export PATH="%s:$PATH"\n' "$2" ;;
    esac
}

remove_path_line_from_rc() {
    rc="$1"; dir="$2"
    [ -f "$rc" ] || return 1
    line=""
    # First candidate that is actually present wins; a file can only hold the
    # line one install wrote.
    while IFS= read -r _cand; do
        [ -n "$_cand" ] || continue
        if grep -Fqx "$_cand" "$rc"; then line="$_cand"; break; fi
    done <<EOF
$(path_line_candidates_for "$rc" "$dir")
EOF
    [ -n "$line" ] || return 1
    tmp="$rc.veyyon-uninstall.$$"
    : > "$tmp" || return 1
    # One line of lookbehind, so the marker comment is dropped only when it is
    # ours (directly above our line) and never when the user has moved it.
    _pending=""; _have_pending=0
    while IFS= read -r _cur || [ -n "$_cur" ]; do
        if [ "$_cur" = "$line" ]; then
            if [ "$_have_pending" -eq 1 ] && [ "$_pending" = "$PATH_MARKER" ]; then
                _have_pending=0
            elif [ "$_have_pending" -eq 1 ]; then
                printf '%s\n' "$_pending" >> "$tmp"
                _have_pending=0
            fi
            continue
        fi
        [ "$_have_pending" -eq 1 ] && printf '%s\n' "$_pending" >> "$tmp"
        _pending="$_cur"; _have_pending=1
    done < "$rc"
    [ "$_have_pending" -eq 1 ] && printf '%s\n' "$_pending" >> "$tmp"
    # Only the `cat` below was checked, so a write that failed while BUILDING the
    # temp (a full disk part-way through a long rc) produced a short file that
    # was then copied over the user's rc and reported as a success. Every removal
    # drops our line, and at most the marker above it, so any other line count
    # means the temp is not a rewrite of this file and must not replace it.
    # Prefixed names: POSIX sh has no `local`, so every variable here is the
    # CALLER's too. A name as ordinary as `_before` silently overwrites whatever
    # the caller was holding under it.
    _rc_lines_before=$(count_lines "$rc")
    _rc_lines_after=$(count_lines "$tmp")
    if [ "$_rc_lines_after" -ne $((_rc_lines_before - 1)) ] && [ "$_rc_lines_after" -ne $((_rc_lines_before - 2)) ]; then
        warn "refusing to rewrite $rc: the rewrite has $_rc_lines_after lines, expected $((_rc_lines_before - 1))"
        warn "    your file is untouched; the partial rewrite is in $tmp"
        return 1
    fi
    if cat "$tmp" > "$rc"; then
        rm -f "$tmp"
        return 0
    fi
    # The redirection TRUNCATES $rc before cat runs, so by the time cat fails
    # (a full disk, an I/O error) the temp file is the ONLY copy of the user's
    # rc left. Deleting it here destroyed a file we had just emptied. Keep it,
    # and say exactly how to put it back.
    warn "could not rewrite $rc — its previous contents are in $tmp"
    warn "    restore it with: cp '$tmp' '$rc'"
    return 1
}

# Whether `$1/$ALIAS_NAME` is an alias THIS installer created: a symlink whose
# target is the binary beside it. link_alias writes exactly that and refuses to
# create anything else, so anything else is a `vey` the user owns.
alias_in_dir_is_ours() {
    _d="$1"
    [ -L "$_d/$ALIAS_NAME" ] || return 1
    [ "$(readlink "$_d/$ALIAS_NAME" 2>/dev/null)" = "$_d/$BIN_NAME" ]
}

# Whether the legacy Bun-global launcher is one this installer could have
# created. Before source installs moved to the canonical install directory,
# `bun install -g @veyyon/pi-coding-agent` wrote this exact symlink. A regular
# executable, or a link to any other target, belongs to the user even though it
# occupies our old filename.
legacy_bun_launcher_is_ours() {
    _legacy_launcher="$1"
    [ -L "$_legacy_launcher" ] || return 1
    _legacy_target=$(readlink "$_legacy_launcher" 2>/dev/null) || return 1
    case "$_legacy_target" in
        "../install/global/node_modules/@veyyon/pi-coding-agent/src/cli.ts"|"$HOME/.bun/install/global/node_modules/@veyyon/pi-coding-agent/src/cli.ts") return 0 ;;
        (*) return 1 ;;
    esac
}

do_uninstall() {
    removed=0; _rc_line_removed=0
    canonical_dir=$(install_dir)
    for d in "$canonical_dir" "$HOME/.bun/bin"; do
        _canonical_binary_owned=0
        if [ "$d" = "$canonical_dir" ] && binary_artifact_is_ours "$d/$BIN_NAME"; then
            _canonical_binary_owned=1
        fi
        # The alias is checked BEFORE the binary is removed, and it is checked at
        # all because install refuses to overwrite a `vey` the user already has.
        # Uninstall deleted it anyway, so removing veyyon destroyed the user's own
        # command — the same identity gate the completion files already had.
        if [ -e "$d/$ALIAS_NAME" ] || [ -L "$d/$ALIAS_NAME" ]; then
            if alias_in_dir_is_ours "$d"; then
                rm -f "$d/$ALIAS_NAME" && { ok "removed $d/$ALIAS_NAME"; removed=1; }
            else
                ok "left $d/$ALIAS_NAME alone (not created by this installer)"
            fi
        fi
        if [ -e "$d/$BIN_NAME" ] || [ -L "$d/$BIN_NAME" ]; then
            # The canonical path still needs ownership proof. Legacy Bun space
            # remains governed by its exact package-link shape.
            if { [ "$d" = "$canonical_dir" ] && [ "$_canonical_binary_owned" = 1 ]; } || legacy_bun_launcher_is_ours "$d/$BIN_NAME"; then
                rm -f "$d/$BIN_NAME" && { remove_owner_receipt "$d/$BIN_NAME"; ok "removed $d/$BIN_NAME"; removed=1; }
            else
                ok "left $d/$BIN_NAME alone (not created by this installer)"
                # "not created by this installer" is the honest summary but not
                # always the whole story: a receipt that no longer matches, or a
                # machine with no sha256 tool, both land here and both leave the
                # user with a file to delete by hand for a reason the line above
                # does not give them.
                if [ "$d" = "$canonical_dir" ] && ! have_sha256_tool; then
                    warn "    no sha256 tool (sha256sum/shasum) is available, so its ownership receipt could not be checked; install coreutils or perl and re-run to have uninstall reclaim it"
                elif [ "$d" = "$canonical_dir" ] && owner_receipt_identity "$d/$BIN_NAME" >/dev/null 2>&1; then
                    warn "    it carries this installer's receipt but has changed since, so the file there now is not the one that was installed"
                elif [ "$d" = "$canonical_dir" ] && artifact_has_legacy_owner_receipt "$d/$BIN_NAME"; then
                    warn "    its receipt predates recorded file identity, so ownership of the file there now cannot be confirmed"
                fi
            fi
        fi
        # A compiled binary probes for a staged addon next to itself; clear any
        # `veyyon_natives.*.node` left beside the removed binary so uninstall does
        # not leave orphaned native artifacts behind.
        for n in "$d"/veyyon_natives.*.node; do
            [ -e "$n" ] && rm -f "$n" && { ok "removed $n"; removed=1; }
        done
        # `veyyon update` stages its download beside the binary and keeps the
        # binary it replaces until the new one has proved itself. On Windows that
        # backup cannot be unlinked while the updating process is alive, and a
        # killed update leaves the staged file, so either can outlive the update
        # that made it. Neither is dot-prefixed, so the installer's own staging
        # sweep never matched them and an uninstall used to report success while
        # leaving a few hundred megabytes behind. Which names count is
        # update_attempt_middle_is_ours's decision, and it is the same one
        # install.ps1's Test-UpdateAttemptLeftover makes.
        for _suffix in new bak; do
            for b in "$d/$BIN_NAME".*".$_suffix" "$d/$BIN_NAME.$_suffix"; do
                # The glob is literal when nothing matches.
                [ -e "$b" ] || continue
                _mid=${b#"$d/$BIN_NAME"}
                _mid=${_mid%".$_suffix"}
                update_attempt_middle_is_ours "$_mid" || continue
                if [ "$_suffix" = new ]; then
                    rm -f "$b" && { ok "removed $b left by an interrupted update"; removed=1; }
                else
                    rm -f "$b" && { ok "removed update backup $b"; removed=1; }
                fi
            done
        done
    done
    src=$(src_dir)
    if [ -d "$src" ]; then
        # A checkout from another repository is foreign even when pristine.
        # Never remove it merely because it occupies the configured source path.
        # Move it aside exactly as the install path does, preserving every ref.
        if [ -d "$src/.git" ] && ! src_remote_is_ours "$src"; then
            warn "source checkout at $src does not track $REPO_URL; preserving it"
            move_aside_existing_src "$src"
            removed=1
        # Never rm -rf a Veyyon checkout that holds uncommitted edits or
        # unpushed local branches. Move it aside so uninstall cannot destroy work
        # the installer did not create; only our own pristine tree is removed.
        elif src_has_local_work "$src"; then
            move_aside_existing_src "$src"
            removed=1
        else
            rm -rf "$src" && { ok "removed source checkout $src"; removed=1; }
        fi
    fi
    for sh in bash zsh fish; do
        out=$(completions_dir_for "$sh")
        [ -n "$out" ] || continue
        # Derive both filenames from the same owner install_completions writes
        # through, so an alias completion can never be orphaned by an uninstall.
        name=$(completion_file_for "$sh" "$BIN_NAME")
        alias_name=$(completion_file_for "$sh" "$ALIAS_NAME")
        # Receipts are authoritative. Legacy generated files are recognized by
        # their shell-specific Veyyon registration so existing users migrate
        # without losing completions on the first receipt-aware upgrade.
        if [ -n "$alias_name" ] && [ -e "$out/$alias_name" ]; then
            if completion_artifact_is_ours "$out/$alias_name" "$sh"; then
                rm -f "$out/$alias_name" && { remove_owner_receipt "$out/$alias_name"; ok "removed $sh completion for '$ALIAS_NAME'"; removed=1; }
            else
                ok "left $sh completion for '$ALIAS_NAME' alone (not written by this installer)"
            fi
        fi
        if [ -n "$name" ] && [ -e "$out/$name" ]; then
            if completion_artifact_is_ours "$out/$name" "$sh"; then
                rm -f "$out/$name" && { remove_owner_receipt "$out/$name"; ok "removed $sh completion for '$BIN_NAME'"; removed=1; }
            else
                ok "left $sh completion for '$BIN_NAME' alone (not written by this installer)"
            fi
        fi
    done
    # Remove the per-version native addon cache a binary install stages there
    # (~150MB per version). The path shape is owned by getNativesDir() in
    # packages/natives/native/loader-state.js — mirror it EXACTLY: honor
    # $XDG_DATA_HOME/veyyon/natives only when $XDG_DATA_HOME/veyyon already
    # exists (the loader's condition), otherwise ~/.veyyon/natives. Only the
    # `natives` cache subdir is removed; the user's auth/config/sessions under
    # ~/.veyyon are left untouched.
    if [ -n "${XDG_DATA_HOME:-}" ] && [ -d "$XDG_DATA_HOME/veyyon" ]; then
        natives_cache="$XDG_DATA_HOME/veyyon/natives"
    else
        natives_cache="$HOME/.veyyon/natives"
    fi
    if [ -d "$natives_cache" ]; then
        rm -rf "$natives_cache" && { ok "removed native addon cache $natives_cache"; removed=1; }
    fi
    # Take back the PATH line, in every rc a past install might have written it
    # to: a user who has changed shells since installing still carries the old
    # shell's line, pointing at a directory veyyon no longer occupies.
    # NOT `rc_candidates | while ...`: a pipeline runs its loop in a SUBSHELL, so
    # `removed=1` set inside was discarded and an uninstall whose only remaining
    # artifact was the PATH line reported "nothing to uninstall" right after
    # printing that it had removed it. IFS is pinned to a newline so a $HOME with
    # a space in it still splits into one path per line.
    _rc_list=$(rc_candidates)
    _old_ifs=$IFS
    IFS='
'
    for rc in $_rc_list; do
        IFS=$_old_ifs
        if remove_path_line_from_rc "$rc" "$(install_dir)"; then
            ok "removed the veyyon PATH line from $rc"
            removed=1
            _rc_line_removed=1
        fi
        IFS='
'
    done
    IFS=$_old_ifs
    # Staging files a killed install left behind are ours too (Windows sweeps
    # its equivalents in Uninstall-Veyyon).
    for stale in "$(install_dir)/.$BIN_NAME".*; do
        [ -e "$stale" ] && rm -f "$stale" && { ok "removed leftover $stale"; removed=1; }
    done
    if [ "$removed" -eq 1 ]; then
        say "veyyon uninstalled."
        # An rc is read when a shell starts, so this shell still holds the PATH
        # entry the uninstall just deleted from the file, and bash and zsh also
        # cache the resolved location of a command they have already run. Without
        # this line, typing `veyyon` right after uninstalling answers "No such
        # file or directory" from a path the user can see is gone, which reads as
        # a half-finished uninstall rather than as a shell that has not caught up.
        # `if`, not `[ ... ] && ...`: an `&&` list whose left side is false yields
        # status 1, and this is the last command in the function, so a successful
        # uninstall on a machine with no PATH line to take back exited 1 and
        # `install.sh --uninstall && ...` read it as a failure.
        if [ "${_rc_line_removed:-0}" = 1 ]; then
            wrap_line "  " "  " 2 "your shell keeps the old PATH entry until it reloads: exec \$SHELL -l"
        fi
    else
        say "nothing to uninstall."
    fi
}


# Where an older installer kept its clone. Nothing creates this directory any
# more: the source-install mode that cloned into it is gone. The path survives
# because `--uninstall` still has to find such a tree on machines that ran the
# old installer, and has to preserve any work in it rather than delete it.
#
# The source checkout, resolved on every call rather than when this file is
# sourced.
#
# It used to be a top-level assignment, which bound $HOME once at load. Anything
# that sources this script and THEN sets $HOME — every case in
# install-tests/functions.test.sh does exactly that — kept the real home's path
# and operated on it: a sandboxed uninstall moved a developer's own
# ~/.veyyon/src aside. An exported VEYYON_SRC_DIR still wins, which is the knob
# a user actually has.
src_dir() { printf '%s' "${VEYYON_SRC_DIR:-$HOME/.veyyon/src}"; }
REPO_URL="https://github.com/${REPO}.git"


# Move an existing tree aside instead of deleting it. Uninstall uses this on a
# legacy checkout it must not destroy: a tree holding local work, or one tracking
# a foreign remote. An empty directory is simply removed (nothing to preserve).
# Fail closed: if the move cannot happen, die rather than fall back to a
# destructive delete.
move_aside_existing_src() {
    src="${1:-$(src_dir)}"
    [ -e "$src" ] || return 0
    if [ -d "$src" ] && [ -z "$(ls -A "$src" 2>/dev/null)" ]; then
        rmdir "$src" 2>/dev/null || true
        return 0
    fi
    stamp=$(date -u +%Y%m%d-%H%M%S)-$$
    backup="$src.bak-$stamp"
    mv "$src" "$backup" || die "refusing to continue: could not move existing $src aside to $backup"
    warn "moved existing $src aside to $backup (nothing was deleted)"
}

# Report (exit 0) whether a source checkout holds work the installer did not
# create and must not delete on uninstall: uncommitted edits, or commits on any
# local branch that live on no remote (this includes the `veyyon-local-*`
# preservation branches from a prior update, so a preserved AGENTS.md is never
# silently `rm -rf`'d out from under the user by `--uninstall`). A non-git but
# non-empty tree is also treated as local work (user files / partial checkout).
# Exit 1 means the tree is pristine and safe to remove outright.
src_has_local_work() {
    src="${1:-$(src_dir)}"
    [ -d "$src" ] || return 1
    if [ ! -d "$src/.git" ]; then
        [ -n "$(ls -A "$src" 2>/dev/null)" ] && return 0 || return 1
    fi
    [ -n "$( cd "$src" 2>/dev/null && git status --porcelain 2>/dev/null )" ] && return 0
    [ -n "$( cd "$src" 2>/dev/null && git log --branches --not --remotes --oneline 2>/dev/null )" ] && return 0
    return 1
}

# A source checkout is installer-owned only when `origin` names the Veyyon
# repository. Directory location and a clean worktree are not ownership proof:
# a user may already have an unrelated pristine checkout at VEYYON_SRC_DIR.
# The exact REPO_URL arm keeps local installer tests and mirrors usable; the
# GitHub spellings cover source installs made through HTTPS and SSH.
src_remote_is_ours() {
    src="${1:-$(src_dir)}"
    [ -d "$src/.git" ] || return 1
    remote=$( cd "$src" 2>/dev/null && git remote get-url origin 2>/dev/null ) || return 1
    case "$remote" in
        "$REPO_URL"|"https://github.com/$REPO"|"https://github.com/$REPO.git"|"git@github.com:$REPO"|"git@github.com:$REPO.git"|"ssh://git@github.com/$REPO"|"ssh://git@github.com/$REPO.git")
            return 0
            ;;
    esac
    return 1
}

# ---- local binary install (from local checkout build) ----
install_local() {
    local_bin=""
    for candidate in "$PWD/packages/coding-agent/dist/vey" "$PWD/dist/vey" "$PWD/../coding-agent/dist/vey"; do
        if [ -f "$candidate" ]; then local_bin="$candidate"; break; fi
    done
    [ -n "$local_bin" ] || die "local compiled binary not found — run 'bun scripts/build-binary.ts' in packages/coding-agent first"
    # Three candidate locations are searched, so name the one that won: a stale
    # dist/ in the current directory otherwise shadows a fresh package build with
    # nothing on screen to explain which binary was actually installed.
    step "installing the local build at $local_bin"
    mkdir -p "$(install_dir)"
    sweep_stale_staging
    tmpbin=$(staging_path local)
    # Same cleanup contract as install_binary: a Ctrl-C or a failed copy must not
    # leave a staging file behind in the user's install directory.
    trap 'rm -f "$tmpbin"' EXIT INT TERM
    cp -f "$local_bin" "$tmpbin" || die "could not stage $local_bin into $(install_dir)"
    finalize_binary "$tmpbin" "$(install_dir)/$BIN_NAME" "rebuild it with 'bun scripts/build-binary.ts' in packages/coding-agent"
    trap - EXIT INT TERM
    ok "installed $BIN_NAME to $(install_dir)/$BIN_NAME"
    link_alias "$(install_dir)"
    install_completions "$(install_dir)/$BIN_NAME"
    ensure_on_path "$(install_dir)"
    doctor "$(install_dir)/$BIN_NAME"
    print_next_steps
}

# Which C library this userland uses: "musl", "glibc", or "unknown".
#
# The published Linux binaries are built with bun's glibc targets
# (`bun-linux-x64-baseline`, `bun-linux-arm64`; see scripts/ci-release-build-binaries.ts).
# On a musl system (Alpine and friends) `uname -s` still says Linux, so the
# installer downloaded a binary that cannot run: the checksum matched, the
# install "succeeded", and the user got the dynamic loader's famously unhelpful
# "not found" on a file that is plainly there. Detect it BEFORE downloading.
detect_libc() {
    [ "$(uname -s)" = "Linux" ] || { printf 'n/a'; return 0; }
    # The loader path is the most reliable signal and needs no subprocess.
    for loader in /lib/ld-musl-*.so.1 /lib64/ld-musl-*.so.1; do
        if [ -e "$loader" ]; then printf 'musl'; return 0; fi
    done
    if has ldd; then
        # musl's ldd exits non-zero on --version while still printing its banner,
        # so the exit status carries no information here; only the text does.
        # The `if` keeps `set -e` out of it and leaves ldd_out assigned either way.
        ldd_out=""
        if ldd_out=$(ldd --version 2>&1); then :; fi
        case "$ldd_out" in
            *musl*) printf 'musl'; return 0 ;;
            *"GNU libc"*|*GLIBC*|*glibc*) printf 'glibc'; return 0 ;;
        esac
    fi
    printf 'unknown'
}

# Refuse a binary install on a libc the release does not build for.
#
# Only a POSITIVE musl detection stops the install. An undetectable libc is not
# treated as musl: glibc is the overwhelming default, and the doctor gate at the
# end still catches a binary that cannot run, so guessing here would block
# working installs to pre-empt a case that is already covered.
require_supported_libc() {
    [ "$(detect_libc)" = "musl" ] || return 0
    die "this system uses musl libc (Alpine and similar), and the published Linux binaries are built against glibc — the download would install cleanly and then fail to start with a misleading 'not found' from the dynamic loader. There is no binary for this system, so $MANUAL_BUILD"
}

# ---- prebuilt binary install ----
install_binary() {
    OS="$(uname -s)"; ARCH="$(uname -m)"
    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *) die "unsupported OS: $OS. No prebuilt binary is published for it, so $MANUAL_BUILD" ;;
    esac
    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *) die "unsupported architecture: $ARCH. No prebuilt binary is published for it, so $MANUAL_BUILD" ;;
    esac
    require_supported_libc
    BINARY="${BIN_NAME}-${PLATFORM}-${ARCH}"

    if [ -n "$REF" ]; then
        step "fetching release $REF..."
        _ref_status=0
        LATEST=$(resolve_ref_tag "$REF") || _ref_status=$?
        case "$_ref_status" in
            0) ;;
            # The tag is real, the release is not. Say that, and say it without
            # mentioning the platform binary: nothing is wrong with the binary,
            # there is no release for it to be part of.
            # $LATEST holds the tag that exists, which is not always what was
            # typed: `--ref 1.0.39` is not a ref git can check out, so echoing it
            # back would be advice that cannot work.
            2) die "no release is published for tag $LATEST, so there is no binary to download. That tag exists in the repository, but nothing was ever released from it (its release may still be an unpublished draft). Pick a version that has a release from https://github.com/${REPO}/releases, or $MANUAL_BUILD" ;;
            *) die "release tag not found: $REF. Only published release tags are installable; for a branch or a commit, $MANUAL_BUILD, adding \`git checkout $REF\` before the setup step" ;;
        esac
        [ "$LATEST" = "$REF" ] || step "resolved $REF to the published tag $LATEST"
    else
        step "fetching latest release..."
        LATEST=$(resolve_latest_tag) \
            || die "could not reach https://github.com/${REPO}/releases/latest (network error, or GitHub is down) — retry once the network is back"
    fi
    step "version: $LATEST"

    mkdir -p "$(install_dir)"
    sweep_stale_staging
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    tmpbin=$(staging_path download)
    # Never leave a partial or tampered download behind: a failed curl, a
    # checksum mismatch (die inside verify_release_binary), or a Ctrl-C must all
    # clean up the temp file. Cleared after the atomic move succeeds.
    trap 'rm -f "$tmpbin"' EXIT INT TERM
    step "downloading $BINARY..."
    # The binary is the one part of the install that takes real time, and `-s`
    # hid every sign of it: on a slow link the installer printed "downloading…"
    # and then said nothing for a minute, which reads as a hang. On a terminal
    # curl draws its progress bar; anywhere else (a pipe, a CI log) the output
    # stays exactly as silent as before, because a progress bar written to a log
    # file is thousands of lines of carriage returns. `--progress-bar` rather
    # than the default meter: one line that fills, not a table of columns.
    # `IS_TTY` rather than `[ -t 1 ]`: same reason the color block hoists it, and
    # the same conditions, so the bar and the color can never disagree about
    # whether a person is watching.
    if [ "$IS_TTY" = 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
        _dl_progress="--progress-bar"
    else
        _dl_progress="-s"
    fi
    # -S keeps curl's own error message on failure, which `-s` alone suppresses.
    curl -fL -S $_dl_progress $CURL_RETRY --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "$tmpbin" \
        || die "download failed: $BINARY may not be published for this release. Check the assets on https://github.com/${REPO}/releases/tag/${LATEST}, or $MANUAL_BUILD"

    verify_release_binary "$tmpbin" "$BINARY_URL" "$BINARY" "$LATEST"

    # Prove the download is the requested release and can run a native search
    # before it is allowed to touch anything. The checksum proves the bytes
    # match what was published, but not that the published asset carries the
    # tag's version or has a working build for this platform. Failing either
    # gate costs only the temp file the trap already removes.
    chmod +x "$tmpbin" || die "could not make the staged download at $tmpbin executable"
    require_release_version "$tmpbin" "$LATEST" "downloaded"
    doctor_natives "$tmpbin" "downloaded"

    finalize_binary "$tmpbin" "$(install_dir)/$BIN_NAME" "the download did not complete — retry"
    trap - EXIT INT TERM
    ok "installed $BIN_NAME to $(install_dir)/$BIN_NAME"
    link_alias "$(install_dir)"
    install_completions "$(install_dir)/$BIN_NAME"
    ensure_on_path "$(install_dir)"
    doctor "$(install_dir)/$BIN_NAME" "$LATEST"
    print_next_steps
}

# ---- main ----
# Tests source this file with VEYYON_INSTALL_SOURCED=1 to exercise the helper
# functions without triggering an install.
if [ "${VEYYON_INSTALL_SOURCED:-0}" != "1" ]; then
    if [ "$DO_UNINSTALL" -eq 1 ]; then
        # No mark on the way out. A logo over a removal reads as a sales pitch
        # at exactly the wrong moment; an uninstall should be quiet and quick.
        do_uninstall
    else
        brand_mark
        # --local is the one mode that installs from the checkout, but it still
        # provisions the native addon over the network, so every install path
        # needs curl. An uninstall does not, and refusing to remove veyyon
        # because a fetch tool is missing would be absurd.
        require_curl
        case "$MODE" in
            local) install_local ;;
            binary) install_binary ;;
            *) install_binary ;;
        esac
    fi
fi
