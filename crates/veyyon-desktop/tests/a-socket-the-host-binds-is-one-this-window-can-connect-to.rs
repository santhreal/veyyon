//! WHY: the desktop window resolved `<agent-dir>/gui-host.sock` without
//! checking `sockaddr_un.sun_path`, so a profile under a long home directory
//! produced a socket path over the platform limit. The host's Bun runtime binds
//! such a path through `/proc/self/fd`, reports it as the endpoint it is
//! listening on, and every `connect()` to the real path fails with EINVAL — the
//! window then retried a socket that could never answer until the reconnect
//! ceiling ended the session, and reported the libc text
//! "path must be shorter than `SUN_LEN`" as its only diagnosis.
//!
//! CLASS CLOSED: any default endpoint this window resolves is one a client can
//! address. The limit is asserted against the kernel rather than restated, the
//! fallback is proved by a bind-and-connect round trip, distinct profiles are
//! proved not to share a socket, and the digest is pinned by known answer so
//! the TypeScript host (`packages/coding-agent/src/gui-host/socket-path.ts`,
//! `test/gui-host/the-socket-the-host-binds-is-one-a-client-can-address.test.
//! ts`) and this window cannot drift apart in silence.
//!
//! NOT CAUGHT: a host and a window that disagree because they read a different
//! `XDG_RUNTIME_DIR` or a different `HOME` — env divergence between two
//! processes is outside a single-process test. The spawn path is covered
//! instead by the host printing the endpoint it bound.

#[path = "support/socket_scratch.rs"]
mod socket_scratch;

use std::{
	env,
	os::unix::net::{UnixListener, UnixStream},
	path::{Path, PathBuf},
	sync::{Mutex, MutexGuard},
};

use socket_scratch::{SocketTree, scratch_dir};
use veyyon_desktop::{
	Endpoint, EndpointError, gui_host_socket_path, runtime_socket_path, unix_path_fits,
	unix_path_limit,
};

/// `XDG_RUNTIME_DIR` is process-wide, so the tests that set it take turns.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Holds `XDG_RUNTIME_DIR` at a value for as long as the guard lives.
struct RuntimeDirEnv {
	_lock:    MutexGuard<'static, ()>,
	previous: Option<PathBuf>,
}

impl RuntimeDirEnv {
	fn set(value: &Path) -> Self {
		let lock = ENV_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let previous = env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
		// SAFETY: every test that reads or writes this variable holds ENV_LOCK,
		// and no thread in this binary reads the environment outside them.
		unsafe { env::set_var("XDG_RUNTIME_DIR", value) };
		Self { _lock: lock, previous }
	}
}

impl Drop for RuntimeDirEnv {
	fn drop(&mut self) {
		match self.previous.take() {
			// SAFETY: as above; the lock is still held by this guard.
			Some(value) => unsafe { env::set_var("XDG_RUNTIME_DIR", value) },
			// SAFETY: as above; the lock is still held by this guard.
			None => unsafe { env::remove_var("XDG_RUNTIME_DIR") },
		}
	}
}

/// A path of exactly `bytes` bytes inside `root`, padded with a filename.
fn path_of_length(root: &Path, bytes: usize) -> PathBuf {
	let prefix = root.join("x").as_os_str().len();
	assert!(prefix < bytes, "scratch root {} is already {prefix} bytes", root.display());
	root.join("x".repeat(bytes - prefix + 1))
}

/// An agent directory under `root` whose socket path cannot be addressed.
fn overlong_agent_dir(root: &Path) -> PathBuf {
	let dir = path_of_length(root, unix_path_limit());
	std::fs::create_dir_all(&dir).expect("scratch agent directory");
	dir
}

fn scratch(label: &str) -> SocketTree {
	scratch_dir(label)
}

#[test]
fn the_limit_this_window_uses_is_the_limit_the_kernel_enforces() {
	let tree = scratch("gui-socket-limit");
	let limit = unix_path_limit();

	let at_limit = path_of_length(&tree, limit);
	assert_eq!(at_limit.as_os_str().len(), limit);
	assert!(unix_path_fits(&at_limit));
	let listener = UnixListener::bind(&at_limit);
	assert!(listener.is_ok(), "a path of {limit} bytes should bind: {:?}", listener.err());
	drop(listener);

	let over_limit = path_of_length(&tree, limit + 1);
	assert_eq!(over_limit.as_os_str().len(), limit + 1);
	assert!(!unix_path_fits(&over_limit));
	assert!(
		UnixListener::bind(&over_limit).is_err(),
		"a path of {} bytes must not bind, or the limit is wrong",
		limit + 1
	);
}

#[test]
fn a_profile_socket_that_fits_is_the_one_the_window_names() {
	let tree = scratch("gui-socket-fits");
	let resolved = gui_host_socket_path(&tree).expect("a short profile path resolves");
	assert_eq!(resolved, tree.join("gui-host.sock"));
}

#[test]
fn a_relative_profile_is_named_absolutely_so_two_working_directories_agree() {
	let resolved = gui_host_socket_path(Path::new("./relative/agent")).expect("relative profile");
	let cwd = env::current_dir().expect("a working directory");
	assert_eq!(resolved, cwd.join("relative/agent/gui-host.sock"));
}

#[test]
fn a_profile_too_deep_for_sun_path_falls_back_to_a_socket_a_client_can_reach() {
	let tree = scratch("gui-socket-fallback");
	let runtime = tree.join("run");
	std::fs::create_dir_all(&runtime).expect("scratch runtime directory");
	let agent_dir = overlong_agent_dir(&tree);

	let preferred = agent_dir.join("gui-host.sock");
	assert!(!unix_path_fits(&preferred), "the preferred path must be the one that cannot be bound");
	assert!(UnixListener::bind(&preferred).is_err(), "negative control: the long path binds");

	let _env = RuntimeDirEnv::set(&runtime);
	let resolved = gui_host_socket_path(&agent_dir).expect("a fallback socket");
	assert!(
		resolved.starts_with(&runtime),
		"fallback {} is not in the runtime dir",
		resolved.display()
	);
	assert!(unix_path_fits(&resolved));

	let listener = UnixListener::bind(&resolved).expect("the fallback socket binds");
	let stream = UnixStream::connect(&resolved);
	assert!(stream.is_ok(), "the fallback socket must accept a connection: {:?}", stream.err());
	drop(stream);
	drop(listener);
}

#[test]
fn two_profiles_never_share_a_fallback_socket() {
	let tree = scratch("gui-socket-distinct");
	let runtime = tree.join("run");
	std::fs::create_dir_all(&runtime).expect("scratch runtime directory");
	let _env = RuntimeDirEnv::set(&runtime);

	let first = runtime_socket_path(Path::new("/home/a/.veyyon/profiles/work/agent"));
	let second = runtime_socket_path(Path::new("/home/b/.veyyon/profiles/work/agent"));
	let same_profile_again = runtime_socket_path(Path::new("/home/a/.veyyon/profiles/work/agent"));

	assert_ne!(first, second, "two homes with one profile name must not collide");
	assert_eq!(first, same_profile_again, "the same profile must resolve to the same socket");
	assert!(first.is_some_and(|path| unix_path_fits(&path)));
}

#[test]
fn a_relative_profile_and_its_absolute_form_name_one_fallback_socket() {
	let tree = scratch("gui-socket-relative-digest");
	let runtime = tree.join("run");
	std::fs::create_dir_all(&runtime).expect("scratch runtime directory");
	let _env = RuntimeDirEnv::set(&runtime);

	let relative = Path::new("relative-profile/agent");
	let absolute = env::current_dir()
		.expect("a working directory")
		.join(relative);
	assert_eq!(
		runtime_socket_path(relative),
		runtime_socket_path(&absolute),
		"a profile named relatively must resolve to the socket its absolute form names"
	);
}

#[test]
fn the_fallback_digest_is_the_one_the_host_derives() {
	let tree = scratch("gui-socket-digest");
	let runtime = tree.join("run");
	std::fs::create_dir_all(&runtime).expect("scratch runtime directory");
	let _env = RuntimeDirEnv::set(&runtime);

	let resolved = runtime_socket_path(Path::new("/home/veyyon/.veyyon/profiles/work/agent"))
		.expect("a runtime socket");
	// SHA-256 of the absolute agent directory, first 16 hex characters. The
	// TypeScript host pins the same answer for the same input.
	assert_eq!(
		resolved.file_name().and_then(|name| name.to_str()),
		Some("veyyon-gui-187cdf3120143ee5.sock")
	);
}

#[test]
fn nothing_short_enough_is_a_refusal_that_names_the_limit_and_what_it_tried() {
	let tree = scratch("gui-socket-refusal");
	let agent_dir = overlong_agent_dir(&tree);
	let long_runtime = path_of_length(&tree, unix_path_limit() - 8);
	std::fs::create_dir_all(&long_runtime).expect("scratch runtime directory");
	let _env = RuntimeDirEnv::set(&long_runtime);

	let error = gui_host_socket_path(&agent_dir).expect_err("no path fits");
	let EndpointError::NoSocketPathFits { tried, limit } = &error else {
		panic!("expected a refusal naming both candidates, got {error:?}");
	};
	assert_eq!(*limit, unix_path_limit());
	assert!(tried.contains("gui-host.sock"), "refusal omits the profile candidate: {tried}");
	assert!(tried.contains("veyyon-gui-"), "refusal omits the runtime candidate: {tried}");
	let rendered = error.to_string();
	assert!(rendered.contains("XDG_RUNTIME_DIR"), "refusal omits the correction: {rendered}");
	assert!(rendered.contains("--endpoint"), "refusal omits the correction: {rendered}");
}

#[test]
fn an_explicit_endpoint_a_client_cannot_reach_is_refused_before_it_is_used() {
	let tree = scratch("gui-socket-explicit");
	let over_limit = path_of_length(&tree, unix_path_limit() + 1);
	let written = format!("unix:{}", over_limit.display());

	let error = Endpoint::parse(&written, None).expect_err("an unreachable path is refused");
	let EndpointError::UnixPathTooLong { bytes, limit, path } = &error else {
		panic!("expected a named length refusal, got {error:?}");
	};
	assert_eq!(*bytes, unix_path_limit() + 1);
	assert_eq!(*limit, unix_path_limit());
	assert_eq!(Path::new(path), over_limit);

	let short = Endpoint::parse("unix:/tmp/veyyon-gui-short.sock", None).expect("a short path");
	assert_eq!(short, Endpoint::Unix { path: PathBuf::from("/tmp/veyyon-gui-short.sock") });
}
