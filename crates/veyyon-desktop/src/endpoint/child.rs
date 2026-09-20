//! The host this window starts, and what it said.
//!
//! A child host that dies takes its reason with it. The window drained the
//! child's stderr into a channel nobody read after startup, so a session that
//! lost its socket drew "Socket connection lost" and the text stating why was
//! discarded in the same process. The stream is kept here instead: every line
//! is printed under a `host:` prefix as it arrives and the last
//! `HOST_STDERR_LINES` of it stay readable on the handle, so the startup
//! failure, a later crash and a recorded take all state the same reason.

use std::{
	collections::VecDeque,
	env,
	io::{BufRead, BufReader},
	path::{Path, PathBuf},
	process::{Command, Stdio},
	sync::{Arc, Mutex, mpsc},
	thread,
	time::{Duration, Instant},
};

use thiserror::Error;

use super::{Endpoint, EndpointError, accepts_connection};

/// How long a spawned host is given to print its endpoint and accept a
/// connection (§8.11).
pub const SPAWN_WAIT_MS: u64 = 5000;

/// Environment variable naming the `veyyon` binary to spawn as the host, for
/// a checkout or an install that is not on `PATH`.
pub const VEYYON_BIN_ENV: &str = "VEYYON_BIN";

/// The line the host prints once it listens, followed by its endpoint.
const LISTENING_PREFIX: &str = "GUI engine host listening at ";

/// How many of the host's most recent stderr lines stay readable.
const HOST_STDERR_LINES: usize = 200;

/// How long the startup path waits for the reader thread to catch up with a
/// child that exited before it listened.
const STDERR_SETTLE_MS: u64 = 250;

/// Errors encountered while spawning a child host process.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum HostSpawnError {
	#[error("no `veyyon` binary on PATH; install veyyon or set {VEYYON_BIN_ENV} to the binary")]
	NoBinary,
	#[error("failed to spawn `{0} gui`: {1}")]
	SpawnFailed(PathBuf, String),
	#[error("`veyyon gui` exited before it listened: {0}")]
	ExitedBeforeListening(String),
	#[error("`veyyon gui` printed no endpoint within {SPAWN_WAIT_MS}ms")]
	NoEndpointLine,
	#[error("`veyyon gui` printed an endpoint that does not parse: {0}")]
	BadEndpoint(#[from] EndpointError),
	#[error("`veyyon gui` reported {endpoint} but it accepted no connection within {waited_ms}ms")]
	NotListening { endpoint: Endpoint, waited_ms: u64 },
}

/// What the host wrote to stderr, most recent lines last.
///
/// Two handles to one host compare equal, which is what the window's state
/// comparisons ask: the text itself moves under both of them and is never the
/// identity of the host.
#[derive(Clone, Debug, Default)]
pub struct HostStderr(Arc<Mutex<VecDeque<String>>>);

impl HostStderr {
	/// The lines kept, oldest first.
	#[must_use]
	pub fn lines(&self) -> Vec<String> {
		self
			.0
			.lock()
			.map_or_else(|_| Vec::new(), |kept| kept.iter().cloned().collect())
	}

	/// The lines kept, as one block of text.
	#[must_use]
	pub fn text(&self) -> String {
		self.lines().join("\n")
	}

	fn push(&self, line: String) {
		if let Ok(mut kept) = self.0.lock() {
			if kept.len() == HOST_STDERR_LINES {
				kept.pop_front();
			}
			kept.push_back(line);
		}
	}

	/// The last `keep` non-empty lines, oldest first, as one sentence.
	#[must_use]
	pub fn last_words(&self, keep: usize) -> Option<String> {
		last_words(&self.lines(), keep)
	}
}

/// The last `keep` non-empty lines of `said`, oldest first, joined into one
/// sentence, or `None` when nothing was written.
///
/// A window states the host's own reason beside a transport failure, and the
/// reason is at the end of the stream: a host that lost its socket printed
/// why on its way out, not when it started.
#[must_use]
pub fn last_words(said: &[String], keep: usize) -> Option<String> {
	let written: Vec<&str> = said
		.iter()
		.map(|line| line.trim())
		.filter(|line| !line.is_empty())
		.collect();
	let tail = written
		.split_at(written.len().saturating_sub(keep))
		.1
		.join("; ");
	(!tail.is_empty()).then_some(tail)
}

impl PartialEq for HostStderr {
	fn eq(&self, other: &Self) -> bool {
		Arc::ptr_eq(&self.0, &other.0)
	}
}

impl Eq for HostStderr {}

/// A host this window started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildHostHandle {
	/// Where the host listens, as it reported.
	pub endpoint: Endpoint,
	/// The host's process id. The host outlives the window that started it,
	/// so the next window attaches instead of starting another.
	pub pid:      u32,
	/// What the host has written to stderr since it started.
	pub stderr:   HostStderr,
}

/// The `veyyon` binary to spawn: `VEYYON_BIN`, else the first `veyyon` on
/// `PATH`.
fn host_binary() -> Option<PathBuf> {
	if let Some(bin) = env::var_os(VEYYON_BIN_ENV).filter(|b| !b.is_empty()) {
		return Some(PathBuf::from(bin));
	}
	env::split_paths(&env::var_os("PATH")?)
		.map(|dir| dir.join("veyyon"))
		.find(|candidate| candidate.is_file())
}

/// Starts `veyyon gui` as a detached child in `cwd` and waits for it to
/// listen.
///
/// The host prints the endpoint it bound; that line, not a path computed
/// here, is what the window attaches to, so the host's own profile and layout
/// rules decide where the socket is. Both of the child's streams are drained
/// for its lifetime so a later write never blocks it, and stderr is kept
/// rather than dropped.
pub fn spawn_child_host(cwd: &Path) -> Result<ChildHostHandle, HostSpawnError> {
	spawn_host_binary(&host_binary().ok_or(HostSpawnError::NoBinary)?, cwd)
}

/// Starts `<bin> gui` as a detached child in `cwd` and waits for it to
/// listen, for a caller that already resolved the binary.
pub fn spawn_host_binary(bin: &Path, cwd: &Path) -> Result<ChildHostHandle, HostSpawnError> {
	let bin = bin.to_path_buf();
	let mut command = Command::new(&bin);
	command
		.arg("gui")
		.current_dir(cwd)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt as _;
		// Its own process group, so the window's terminal signals do not
		// reach a host other windows will attach to.
		command.process_group(0);
	}
	let mut child = command
		.spawn()
		.map_err(|err| HostSpawnError::SpawnFailed(bin.clone(), err.to_string()))?;
	let pid = child.id();

	let Some(stdout) = child.stdout.take() else {
		return Err(HostSpawnError::SpawnFailed(bin, "stdout was not piped".to_string()));
	};
	let Some(stderr) = child.stderr.take() else {
		return Err(HostSpawnError::SpawnFailed(bin, "stderr was not piped".to_string()));
	};

	let (lines_tx, lines_rx) = mpsc::channel::<String>();
	thread::Builder::new()
		.name("veyyon-gui-stdout".to_string())
		.spawn(move || {
			for line in BufReader::new(stdout).lines().map_while(Result::ok) {
				// The child may become ready after the startup deadline.
				// Keep its pipe open even after the waiting caller returns.
				let _ = lines_tx.send(line);
			}
		})
		.map_err(|err| HostSpawnError::SpawnFailed(bin.clone(), err.to_string()))?;
	let kept = HostStderr::default();
	let sink = kept.clone();
	thread::Builder::new()
		.name("veyyon-gui-stderr".to_string())
		.spawn(move || {
			for line in BufReader::new(stderr).lines().map_while(Result::ok) {
				eprintln!("host: {line}");
				sink.push(line);
			}
		})
		.map_err(|err| HostSpawnError::SpawnFailed(bin.clone(), err.to_string()))?;

	let started = Instant::now();
	let deadline = started + Duration::from_millis(SPAWN_WAIT_MS);
	let endpoint = loop {
		let remaining = deadline.saturating_duration_since(Instant::now());
		match lines_rx.recv_timeout(remaining) {
			Ok(line) => {
				if let Some(written) = line.strip_prefix(LISTENING_PREFIX) {
					break Endpoint::parse(written.trim(), None)?;
				}
			},
			Err(mpsc::RecvTimeoutError::Timeout) => return Err(HostSpawnError::NoEndpointLine),
			Err(mpsc::RecvTimeoutError::Disconnected) => {
				let status = child
					.try_wait()
					.ok()
					.flatten()
					.map_or_else(|| "output closed".to_string(), |s| s.to_string());
				// The reader thread is still draining what the child wrote on
				// its way out; the reason is in those last lines.
				thread::sleep(Duration::from_millis(STDERR_SETTLE_MS));
				let said = kept.text();
				return Err(HostSpawnError::ExitedBeforeListening(if said.trim().is_empty() {
					status
				} else {
					format!("{status}: {}", said.trim())
				}));
			},
		}
	};

	// Keep draining stdout after the endpoint line, for the host's lifetime.
	thread::Builder::new()
		.name("veyyon-gui-drain".to_string())
		.spawn(move || for _ in lines_rx {})
		.map_err(|err| HostSpawnError::SpawnFailed(bin, err.to_string()))?;

	while !accepts_connection(&endpoint) {
		if Instant::now() >= deadline {
			return Err(HostSpawnError::NotListening { endpoint, waited_ms: SPAWN_WAIT_MS });
		}
		thread::sleep(Duration::from_millis(50));
	}

	Ok(ChildHostHandle { endpoint, pid, stderr: kept })
}
