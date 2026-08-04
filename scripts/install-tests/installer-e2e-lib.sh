#!/usr/bin/env bash
# The installer's end-to-end contract, once, for both ways of getting the binary.
#
# `install.sh --local` installs the binary the checkout just built, which is what
# `run-ci.sh` gates on every push. `install.sh` with no mode installs the
# PUBLISHED release, which is what `curl -fsSL https://get.veyyon.dev | sh` does
# on a user's machine and what `published-release-e2e.sh` gates after a merge.
# Everything the installer does AROUND the binary is identical in both cases:
# the alias, the completions, the rc line, the doctor self-check, and reclaiming
# all of it on uninstall.
#
# So the assertions live here and each caller supplies the mode. Two copies would
# drift, and the copy that drifts is the published-release one, because it runs
# on fewer commits and is the one users actually get.
#
# Source it, then call `installer_end_to_end <work-dir> [mode-args...]`.

# Assert on real paths and real file contents; a "the installer exited 0" check
# would pass for an install that placed nothing.
expect_exists() {
   [ -e "$1" ] || { echo "installer end-to-end: expected $1 to exist ($2)"; exit 1; }
}
expect_absent() {
   [ ! -e "$1" ] || { echo "installer end-to-end: expected $1 to be gone ($2)"; exit 1; }
}

# The full end-to-end: install, reinstall, uninstall, then the no-clobber rules
# for a `vey` the user already owns.
#
# $1 is a scratch directory the caller owns and removes. Everything after it is
# passed to install.sh as its mode (`--local`, or nothing at all for the
# published release).
installer_end_to_end() {
   local work_dir="$1"; shift
   local install_sh="$INSTALLER_E2E_ROOT/scripts/install.sh"
   local installer_home="$work_dir/installer-home"
   local installer_bin="$installer_home/bin"
   mkdir -p "$installer_home"

   installer_env() {
      # A minimal PATH, deliberately: it keeps the run independent of whatever
      # veyyon the machine running the gate already has installed (which would
      # otherwise shadow the sandbox copy and make doctor's output depend on the
      # host), and it leaves the install dir off PATH, which is the state a fresh
      # install is actually in and the reason the installer writes the rc line.
      #
      # `curl` is on that PATH because the published-release mode has to reach
      # the network; the --local mode never uses it.
      env PATH="/usr/local/bin:/usr/bin:/bin" \
          HOME="$installer_home" \
          XDG_DATA_HOME="$installer_home/.local/share" \
          XDG_CONFIG_HOME="$installer_home/.config" \
          VEYYON_INSTALL_DIR="$installer_bin" \
          VEYYON_SRC_DIR="$installer_home/.veyyon/src" \
          SHELL=/bin/bash \
          "$@"
   }

   installer_env sh "$install_sh" "$@"

   expect_exists "$installer_bin/veyyon" "the binary itself"
   [ -x "$installer_bin/veyyon" ] || { echo "installer end-to-end: $installer_bin/veyyon is not executable"; exit 1; }
   expect_exists "$installer_bin/vey" "the vey launch alias"
   [ -L "$installer_bin/vey" ] || { echo "installer end-to-end: vey should be a symlink to the binary"; exit 1; }

   # A completed install put a binary here and NOTHING under $HOME/.veyyon/src.
   # The installer used to be able to clone the product into that directory and
   # build it there, which left a second divergent checkout on the machine that no
   # user asked for. It downloads a verified binary or it fails now, so the
   # directory must not exist at all — and it is named explicitly in this sandbox
   # HOME via VEYYON_SRC_DIR above, so an install that still cloned would land
   # exactly here.
   expect_absent "$installer_home/.veyyon/src" "a source checkout the installer must never create"

   # The release transaction supplies the immutable tag it just published. A
   # healthy previous release is not evidence for the new one, so require the
   # installed binary to report that exact tag before reinstall or uninstall.
   local installed_version
   installed_version="$(installer_env "$installer_bin/veyyon" --version)"
   if [ -n "${VEYYON_EXPECTED_RELEASE_TAG:-}" ]; then
      case "$VEYYON_EXPECTED_RELEASE_TAG" in
         v[0-9]*.[0-9]*.[0-9]*) ;;
         *)
            echo "installer end-to-end: invalid VEYYON_EXPECTED_RELEASE_TAG '$VEYYON_EXPECTED_RELEASE_TAG'"
            exit 1
            ;;
      esac
      local expected_version="veyyon/${VEYYON_EXPECTED_RELEASE_TAG#v}"
      [ "$installed_version" = "$expected_version" ] || {
         echo "installer end-to-end: installed '$installed_version', expected '$expected_version'"
         exit 1
      }
   fi

   # Completions: one file per shell, plus the alias's own file for the two shells
   # that key autoload on the command name.
   expect_exists "$installer_home/.local/share/bash-completion/completions/veyyon" "bash completions"
   expect_exists "$installer_home/.local/share/bash-completion/completions/vey" "bash completions for the alias"
   expect_exists "$installer_home/.local/share/zsh/site-functions/_veyyon" "zsh completions"
   expect_exists "$installer_home/.config/fish/completions/veyyon.fish" "fish completions"
   expect_exists "$installer_home/.config/fish/completions/vey.fish" "fish completions for the alias"

   # The PATH line, with the marker that makes it recognizable on uninstall.
   #
   # The directory is SINGLE-quoted and `$PATH` is not. That is deliberate and is
   # the shape install.sh writes: a directory name containing `$`, a backtick or a
   # backslash would otherwise be expanded by the shell reading the rc, which is how
   # `export PATH="/home/a$PATH/bin:$PATH"` put a nonsense entry on PATH and left the
   # user with "command not found" in a shell whose rc plainly named the right
   # directory. This assertion matched the old double-quoted form and so failed
   # every run after the fix landed; matching the bytes exactly is the point, since
   # the uninstall recognizes its own line by them.
   local path_line="export PATH='$installer_bin':\"\$PATH\""
   # WHICH rc is the installer's choice to make, not this gate's to assume. A bash
   # login shell reads `.bashrc` on Linux and `.bash_profile` on macOS, so pinning
   # one name failed every macOS run with "the PATH line is missing from .bashrc"
   # about an install that had done exactly the right thing. So: find the rc the
   # installer marked, and require exactly one.
   local rc=""
   local candidate
   for candidate in "$installer_home/.bashrc" "$installer_home/.bash_profile" "$installer_home/.profile"; do
      [ -f "$candidate" ] || continue
      grep -Fqx "# added by the veyyon installer" "$candidate" || continue
      [ -z "$rc" ] || {
         echo "installer end-to-end: the PATH line is in more than one rc ($rc and $candidate)"
         exit 1
      }
      rc="$candidate"
   done
   [ -n "$rc" ] || {
      echo "installer end-to-end: no rc under $installer_home carries the installer's marker"
      exit 1
   }
   grep -Fqx "$path_line" "$rc" || {
      echo "installer end-to-end: the PATH line is missing from $rc"
      exit 1
   }

   # A user's own rc content must survive the uninstall untouched.
   echo "alias ll='ls -la'" >> "$rc"

   # Reinstalling over an existing install must be clean and idempotent: no
   # duplicate PATH line, no staging litter, no failure.
   installer_env sh "$install_sh" "$@"
   local path_lines
   path_lines="$(grep -Fxc "$path_line" "$rc" || true)"
   [ "$path_lines" = "1" ] || {
      echo "installer end-to-end: reinstall wrote the PATH line $path_lines times, expected 1"
      exit 1
   }

   # An upgrade over an existing install is its own path through the script, so it
   # gets the same question asked of the first install: no checkout, ever.
   expect_absent "$installer_home/.veyyon/src" "a source checkout after reinstall"

   installer_env sh "$install_sh" --uninstall

   expect_absent "$installer_bin/veyyon" "the binary after uninstall"
   expect_absent "$installer_bin/vey" "the alias after uninstall"
   expect_absent "$installer_home/.local/share/bash-completion/completions/veyyon" "bash completions after uninstall"
   expect_absent "$installer_home/.local/share/bash-completion/completions/vey" "alias bash completions after uninstall"
   expect_absent "$installer_home/.local/share/zsh/site-functions/_veyyon" "zsh completions after uninstall"
   expect_absent "$installer_home/.config/fish/completions/veyyon.fish" "fish completions after uninstall"
   expect_absent "$installer_home/.config/fish/completions/vey.fish" "alias fish completions after uninstall"

   if grep -Fq "$installer_bin" "$rc"; then
      echo "installer end-to-end: uninstall left the PATH line in $rc"
      exit 1
   fi
   grep -Fqx "alias ll='ls -la'" "$rc" || {
      echo "installer end-to-end: uninstall removed the user's own rc content"
      exit 1
   }

   # Nothing of ours may remain in the install directory, staging files included.
   local leftovers
   leftovers="$(ls -A "$installer_bin" 2>/dev/null || true)"
   [ -z "$leftovers" ] || {
      echo "installer end-to-end: uninstall left files behind: $leftovers"
      exit 1
   }
}

# The no-clobber rule, driven for real. A user who already has a `vey` command
# must keep it, keep its completions, AND not have our completions bound to it:
# every generated script normally completes both names, so declining to write
# the alias FILE was never enough on its own.
installer_no_clobber() {
   local work_dir="$1"; shift
   local install_sh="$INSTALLER_E2E_ROOT/scripts/install.sh"
   local foreign_home="$work_dir/foreign-home"
   local foreign_bin="$foreign_home/bin"
   mkdir -p "$foreign_bin" "$foreign_home/.local/share/bash-completion/completions"

   foreign_env() {
      env PATH="/usr/local/bin:/usr/bin:/bin" \
          HOME="$foreign_home" \
          XDG_DATA_HOME="$foreign_home/.local/share" \
          XDG_CONFIG_HOME="$foreign_home/.config" \
          VEYYON_INSTALL_DIR="$foreign_bin" \
          VEYYON_SRC_DIR="$foreign_home/.veyyon/src" \
          SHELL=/bin/bash \
          "$@"
   }

   printf '#!/bin/sh\necho their tool\n' > "$foreign_bin/vey"
   chmod +x "$foreign_bin/vey"
   printf 'complete -F _their_tool vey\n' > "$foreign_home/.local/share/bash-completion/completions/vey"

   foreign_env sh "$install_sh" "$@"

   grep -Fqx "echo their tool" "$foreign_bin/vey" || {
      echo "installer end-to-end: the user's own vey was overwritten"
      exit 1
   }
   grep -Fqx "complete -F _their_tool vey" "$foreign_home/.local/share/bash-completion/completions/vey" || {
      echo "installer end-to-end: the user's own vey completion was overwritten"
      exit 1
   }
   # The decisive one: our own completion script must not bind their name.
   if grep -Eq '^complete -F _veyyon veyyon vey$' "$foreign_home/.local/share/bash-completion/completions/veyyon"; then
      echo "installer end-to-end: our bash completion still binds a vey we do not own"
      exit 1
   fi
   if grep -Eq '^#compdef veyyon vey$' "$foreign_home/.local/share/zsh/site-functions/_veyyon"; then
      echo "installer end-to-end: our zsh completion still binds a vey we do not own"
      exit 1
   fi
   if grep -q 'complete -c vey -w veyyon' "$foreign_home/.config/fish/completions/veyyon.fish"; then
      echo "installer end-to-end: our fish completion still binds a vey we do not own"
      exit 1
   fi
   # Our own name must still complete fully; the alias is the only thing dropped.
   grep -Fq "complete -F _veyyon veyyon" "$foreign_home/.local/share/bash-completion/completions/veyyon" || {
      echo "installer end-to-end: our own bash completion is missing"
      exit 1
   }

   foreign_env sh "$install_sh" --uninstall

   grep -Fqx "echo their tool" "$foreign_bin/vey" || {
      echo "installer end-to-end: uninstall removed the user's own vey"
      exit 1
   }
   grep -Fqx "complete -F _their_tool vey" "$foreign_home/.local/share/bash-completion/completions/vey" || {
      echo "installer end-to-end: uninstall removed the user's own vey completion"
      exit 1
   }
}
