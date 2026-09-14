//! Where the GUI host's default Unix socket is, and the limit that decides it.
//!
//! `sockaddr_un.sun_path` is a fixed byte array, so a Unix socket has a
//! maximum addressable path length: 108 bytes on Linux, 104 on the BSDs and
//! macOS, one of which is the terminating NUL. A profile directory under a long
//! home directory pushes `<agent-dir>/gui-host.sock` past it, and `connect()`
//! then fails with EINVAL before it reaches the file.
//!
//! The host's Bun runtime binds such a path through `/proc/self/fd`, so it
//! reports a listening endpoint this window cannot reach. Both sides therefore
//! apply one rule, mirrored in
//! `packages/coding-agent/src/gui-host/socket-path.ts`:
//!
//! 1. `<agent-dir>/gui-host.sock` when it fits.
//! 2. `<runtime-dir>/veyyon-gui-<digest>.sock`, where `<digest>` is the first
//!    16 hex characters of the SHA-256 of the absolute agent directory, so two
//!    profiles never share a socket, and `<runtime-dir>` is `$XDG_RUNTIME_DIR`,
//!    else Linux's `/run/user/<uid>` when the current user owns it, else
//!    macOS's per-user `$TMPDIR`.
//! 3. Otherwise a refusal naming the candidates, their sizes and the limit.

use std::{
	env,
	path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use super::{DEFAULT_SOCKET_FILENAME, EndpointError};

/// `sun_path` capacity on Linux, including the terminating NUL.
const SUN_PATH_BYTES_LINUX: usize = 108;

/// `sun_path` capacity on the BSDs and macOS, including the terminating NUL.
const SUN_PATH_BYTES_BSD: usize = 104;

/// Prefix of a socket placed in the runtime directory.
const RUNTIME_SOCKET_PREFIX: &str = "veyyon-gui-";

/// Hex characters of the agent-directory digest kept in a runtime socket name.
const DIGEST_CHARS: usize = 16;

/// Longest socket path this platform can address, excluding the NUL.
#[must_use]
pub const fn unix_path_limit() -> usize {
	if cfg!(target_os = "linux") {
		SUN_PATH_BYTES_LINUX - 1
	} else {
		SUN_PATH_BYTES_BSD - 1
	}
}

/// Whether `socket_path` is short enough for `connect()` to address it.
#[must_use]
pub fn unix_path_fits(socket_path: &Path) -> bool {
	socket_path.as_os_str().len() <= unix_path_limit()
}

/// Whether `dir` is a directory owned by `uid`.
#[cfg(target_os = "linux")]
fn owned_directory(dir: &Path, uid: u32) -> bool {
	use std::os::unix::fs::MetadataExt;
	std::fs::metadata(dir).is_ok_and(|meta| meta.is_dir() && meta.uid() == uid)
}

/// systemd's per-user directory, when this user owns it.
#[cfg(target_os = "linux")]
fn platform_runtime_directory() -> Option<PathBuf> {
	// SAFETY: `getuid` reads the calling process's own credentials. It takes no
	// arguments, touches no memory the caller owns, and cannot fail.
	let uid = unsafe { libc::getuid() };
	let candidate = PathBuf::from(format!("/run/user/{uid}"));
	owned_directory(&candidate, uid).then_some(candidate)
}

/// macOS's per-user temporary directory, which is private to this user.
#[cfg(target_os = "macos")]
fn platform_runtime_directory() -> Option<PathBuf> {
	env::var_os("TMPDIR")
		.map(PathBuf::from)
		.filter(|dir| !dir.as_os_str().is_empty())
}

/// No platform default outside Linux and macOS: the caller states one.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn platform_runtime_directory() -> Option<PathBuf> {
	None
}

/// The short per-user directory a socket falls back to, or `None` when this
/// system offers none.
#[must_use]
pub fn runtime_directory() -> Option<PathBuf> {
	env::var_os("XDG_RUNTIME_DIR")
		.map(PathBuf::from)
		.filter(|dir| !dir.as_os_str().is_empty())
		.or_else(platform_runtime_directory)
}

/// Lowercase hex digits, in the order a nibble indexes them.
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// The digest naming `agent_dir`'s socket in a shared runtime directory.
fn agent_dir_digest(agent_dir: &Path) -> String {
	let absolute = absolute_agent_dir(agent_dir);
	let digest = Sha256::digest(absolute.as_os_str().as_encoded_bytes());
	let mut out = String::with_capacity(DIGEST_CHARS);
	for byte in digest.iter().take(DIGEST_CHARS / 2) {
		out.push(char::from(HEX_DIGITS[usize::from(byte >> 4)]));
		out.push(char::from(HEX_DIGITS[usize::from(byte & 0x0f)]));
	}
	out
}

/// `agent_dir` made absolute the way the host's `path.resolve` does: against
/// the process's working directory, without touching the filesystem.
fn absolute_agent_dir(agent_dir: &Path) -> PathBuf {
	if agent_dir.is_absolute() {
		return normalize(agent_dir);
	}
	match env::current_dir() {
		Ok(cwd) => normalize(&cwd.join(agent_dir)),
		Err(_) => normalize(agent_dir),
	}
}

/// Drops `.` components and resolves `..` lexically, matching `path.resolve`.
fn normalize(path: &Path) -> PathBuf {
	use std::path::Component;
	let mut out = PathBuf::new();
	for component in path.components() {
		match component {
			Component::CurDir => {},
			Component::ParentDir => {
				out.pop();
			},
			other => out.push(other.as_os_str()),
		}
	}
	out
}

/// The runtime-directory socket for `agent_dir`, or `None` without such a
/// directory.
#[must_use]
pub fn runtime_socket_path(agent_dir: &Path) -> Option<PathBuf> {
	let runtime_dir = runtime_directory()?;
	Some(runtime_dir.join(format!("{RUNTIME_SOCKET_PREFIX}{}.sock", agent_dir_digest(agent_dir))))
}

/// The default socket path for `agent_dir`, applying the rule above.
pub fn gui_host_socket_path(agent_dir: &Path) -> Result<PathBuf, EndpointError> {
	let preferred = absolute_agent_dir(agent_dir).join(DEFAULT_SOCKET_FILENAME);
	if unix_path_fits(&preferred) {
		return Ok(preferred);
	}
	let fallback = runtime_socket_path(agent_dir);
	if let Some(fallback) = fallback.as_ref().filter(|path| unix_path_fits(path)) {
		return Ok(fallback.clone());
	}
	let mut tried = describe(&preferred);
	if let Some(fallback) = fallback {
		tried.push_str(" and ");
		tried.push_str(&describe(&fallback));
	}
	Err(EndpointError::NoSocketPathFits { tried, limit: unix_path_limit() })
}

/// Refuses an explicit socket path this window could not connect to.
pub fn check_unix_path(socket_path: &Path) -> Result<(), EndpointError> {
	if unix_path_fits(socket_path) {
		return Ok(());
	}
	Err(EndpointError::UnixPathTooLong {
		path:  socket_path.display().to_string(),
		bytes: socket_path.as_os_str().len(),
		limit: unix_path_limit(),
	})
}

fn describe(path: &Path) -> String {
	format!("{} ({} bytes)", path.display(), path.as_os_str().len())
}
