use std::{
	env, fmt,
	io::{BufRead, BufReader, Read},
	net::{TcpStream, ToSocketAddrs},
	path::{Path, PathBuf},
	process::{Command, Stdio},
	sync::mpsc,
	thread,
	time::{Duration, Instant},
};

use thiserror::Error;

/// Environment variable used to discover the GUI host endpoint when not passed
/// explicitly.
pub const VEYYON_GUI_ENDPOINT_ENV: &str = "VEYYON_GUI_ENDPOINT";

/// Default socket filename within an agent profile directory.
pub const DEFAULT_SOCKET_FILENAME: &str = "gui-host.sock";

/// Errors encountered while parsing or resolving host endpoints.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EndpointError {
	#[error("Unix endpoint path must not be empty")]
	EmptyUnixPath,
	#[error("TCP endpoint must specify a port (e.g. tcp:127.0.0.1:7654): '{0}'")]
	MissingTcpPort(String),
	#[error("Invalid TCP port number: '{0}'")]
	InvalidTcpPort(String),
}

/// How long a spawned host is given to print its endpoint and accept a
/// connection (§8.11).
pub const SPAWN_WAIT_MS: u64 = 5000;

/// Environment variable naming the `veyyon` binary to spawn as the host, for
/// a checkout or an install that is not on `PATH`.
pub const VEYYON_BIN_ENV: &str = "VEYYON_BIN";

/// Environment variable naming the profile whose agent directory holds the
/// default socket.
pub const VEYYON_PROFILE_ENV: &str = "VEYYON_PROFILE";

/// The line the host prints once it listens, followed by its endpoint.
const LISTENING_PREFIX: &str = "GUI engine host listening at ";

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
	NotListening { endpoint: String, waited_ms: u64 },
}

/// Target socket connection descriptor for the desktop transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
	Unix { path: PathBuf },
	Tcp { host: String, port: u16 },
}

impl Endpoint {
	/// Constructs the default unix endpoint for a given agent directory.
	#[must_use]
	pub fn default_unix(agent_dir: &Path) -> Self {
		Self::Unix { path: agent_dir.join(DEFAULT_SOCKET_FILENAME) }
	}

	/// Parses an endpoint string matching the host server grammar.
	///
	/// Recognizes:
	/// - `unix:<path>`: Unix domain socket at `<path>`
	/// - `tcp:<host>:<port>`: TCP socket at `<host>:<port>`, defaulting host to
	///   `127.0.0.1` if empty
	/// - bare string: defaults to the unix socket inside `default_agent_dir`
	pub fn parse(written: &str, default_agent_dir: Option<&Path>) -> Result<Self, EndpointError> {
		if let Some(socket_path) = written.strip_prefix("unix:") {
			if socket_path.trim().is_empty() {
				return Err(EndpointError::EmptyUnixPath);
			}
			return Ok(Self::Unix { path: PathBuf::from(socket_path) });
		}

		if let Some(authority) = written.strip_prefix("tcp:") {
			let Some((host_part, port_str)) = authority.rsplit_once(':') else {
				return Err(EndpointError::MissingTcpPort(written.to_string()));
			};

			let host = if host_part.is_empty() {
				"127.0.0.1".to_string()
			} else {
				host_part.to_string()
			};

			let port = match port_str.parse::<i64>() {
				Ok(p) if (1..=65535).contains(&p) => match u16::try_from(p) {
					Ok(valid) => valid,
					Err(_) => return Err(EndpointError::InvalidTcpPort(port_str.to_string())),
				},
				_ => return Err(EndpointError::InvalidTcpPort(port_str.to_string())),
			};

			return Ok(Self::Tcp { host, port });
		}

		// Fallback to default unix socket when no scheme is supplied
		let socket_path = match default_agent_dir {
			Some(dir) => dir.join(DEFAULT_SOCKET_FILENAME),
			None => PathBuf::from(DEFAULT_SOCKET_FILENAME),
		};

		Ok(Self::Unix { path: socket_path })
	}

	/// Resolves the endpoint following §8.12's priority:
	/// 1. Explicit endpoint string (CLI argument or option).
	/// 2. `VEYYON_GUI_ENDPOINT` environment variable.
	/// 3. Default unix domain socket at `<agent-dir>/gui-host.sock`.
	pub fn resolve(explicit: Option<&str>, agent_dir: &Path) -> Result<Self, EndpointError> {
		if let Some(raw) = explicit {
			let trimmed = raw.trim();
			if !trimmed.is_empty() {
				return Self::parse(trimmed, Some(agent_dir));
			}
		}

		if let Ok(env_val) = std::env::var(VEYYON_GUI_ENDPOINT_ENV) {
			let trimmed = env_val.trim();
			if !trimmed.is_empty() {
				return Self::parse(trimmed, Some(agent_dir));
			}
		}

		Ok(Self::default_unix(agent_dir))
	}

	/// Returns canonical formatted wire representation (`unix:<path>` or
	/// `tcp:<host>:<port>`).
	#[must_use]
	pub fn formatted(&self) -> String {
		match self {
			Self::Unix { path } => format!("unix:{}", path.display()),
			Self::Tcp { host, port } => format!("tcp:{host}:{port}"),
		}
	}
}

impl fmt::Display for Endpoint {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}", self.formatted())
	}
}

/// A host this window started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildHostHandle {
	/// Where the host listens, as it reported.
	pub endpoint: Endpoint,
	/// The host's process id. The host outlives the window that started it,
	/// so the next window attaches instead of starting another.
	pub pid:      u32,
}

/// The active profile's agent directory, where the default socket is.
///
/// Mirrors the host's layout: `~/.veyyon/profiles/<profile>/agent`, with the
/// profile from `VEYYON_PROFILE` or `default`. `None` when there is no home
/// directory to build it under.
#[must_use]
pub fn default_agent_dir() -> Option<PathBuf> {
	let home = env::var_os("HOME")?;
	let profile = env::var(VEYYON_PROFILE_ENV)
		.ok()
		.filter(|p| !p.trim().is_empty())
		.unwrap_or_else(|| "default".to_string());
	Some(
		PathBuf::from(home)
			.join(".veyyon")
			.join("profiles")
			.join(profile)
			.join("agent"),
	)
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

/// Whether the endpoint accepts a connection right now.
#[must_use]
pub fn accepts_connection(endpoint: &Endpoint) -> bool {
	match endpoint {
		#[cfg(unix)]
		Endpoint::Unix { path } => std::os::unix::net::UnixStream::connect(path).is_ok(),
		#[cfg(not(unix))]
		Endpoint::Unix { .. } => false,
		Endpoint::Tcp { host, port } => {
			let Some(addr) = (host.as_str(), *port)
				.to_socket_addrs()
				.ok()
				.and_then(|mut addrs| addrs.next())
			else {
				return false;
			};
			TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
		},
	}
}

/// Starts `veyyon gui` as a detached child in `cwd` and waits for it to
/// listen.
///
/// The host prints the endpoint it bound; that line, not a path computed
/// here, is what the window attaches to, so the host's own profile and layout
/// rules decide where the socket is. The child's output is drained for its
/// lifetime so a later write never blocks it.
pub fn spawn_child_host(cwd: &Path) -> Result<ChildHostHandle, HostSpawnError> {
	let bin = host_binary().ok_or(HostSpawnError::NoBinary)?;
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
				if lines_tx.send(line).is_err() {
					break;
				}
			}
		})
		.map_err(|err| HostSpawnError::SpawnFailed(bin.clone(), err.to_string()))?;
	let (stderr_tx, stderr_rx) = mpsc::channel::<String>();
	thread::Builder::new()
		.name("veyyon-gui-stderr".to_string())
		.spawn(move || {
			let mut text = String::new();
			let _ = BufReader::new(stderr).read_to_string(&mut text);
			let _ = stderr_tx.send(text);
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
				let stderr = stderr_rx
					.recv_timeout(Duration::from_millis(250))
					.unwrap_or_default();
				return Err(HostSpawnError::ExitedBeforeListening(if stderr.trim().is_empty() {
					status
				} else {
					format!("{status}: {}", stderr.trim())
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
			return Err(HostSpawnError::NotListening {
				endpoint:  endpoint.formatted(),
				waited_ms: SPAWN_WAIT_MS,
			});
		}
		thread::sleep(Duration::from_millis(50));
	}

	Ok(ChildHostHandle { endpoint, pid })
}

/// Errors from resolving where the window attaches.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AttachError {
	#[error(transparent)]
	Endpoint(#[from] EndpointError),
	#[error(transparent)]
	Spawn(#[from] HostSpawnError),
	#[error(
		"no home directory, so no default socket; pass --endpoint or set {VEYYON_GUI_ENDPOINT_ENV}"
	)]
	NoAgentDir,
}

/// Where the window attaches, and the host it started to get there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
	pub endpoint: Endpoint,
	pub spawned:  Option<ChildHostHandle>,
}

/// Resolves the connect-or-spawn topology (§8.11).
///
/// An explicit endpoint, from the flag or `VEYYON_GUI_ENDPOINT`, is attached
/// to as given and never spawns. Otherwise the profile's default socket is
/// tried, and a host is started in `cwd` when nothing answers there.
pub fn connect_or_spawn(explicit: Option<&str>, cwd: &Path) -> Result<Attachment, AttachError> {
	let explicit_given = explicit.is_some_and(|e| !e.trim().is_empty())
		|| env::var(VEYYON_GUI_ENDPOINT_ENV).is_ok_and(|e| !e.trim().is_empty());
	let agent_dir = default_agent_dir();
	if explicit_given {
		let endpoint =
			Endpoint::resolve(explicit, agent_dir.as_deref().unwrap_or_else(|| Path::new(".")))?;
		return Ok(Attachment { endpoint, spawned: None });
	}

	let agent_dir = agent_dir.ok_or(AttachError::NoAgentDir)?;
	let endpoint = Endpoint::default_unix(&agent_dir);
	if accepts_connection(&endpoint) {
		return Ok(Attachment { endpoint, spawned: None });
	}
	let spawned = spawn_child_host(cwd)?;
	Ok(Attachment { endpoint: spawned.endpoint.clone(), spawned: Some(spawned) })
}
