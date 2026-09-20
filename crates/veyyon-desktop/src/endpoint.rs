use std::{
	env, fmt,
	net::{TcpStream, ToSocketAddrs},
	path::{Path, PathBuf},
	time::Duration,
};

use thiserror::Error;

mod child;
mod socket_path;

pub use child::{
	ChildHostHandle, HostSpawnError, HostStderr, SPAWN_WAIT_MS, VEYYON_BIN_ENV, last_words,
	spawn_child_host, spawn_host_binary,
};
pub use socket_path::{
	check_unix_path, gui_host_socket_path, runtime_directory, runtime_socket_path, unix_path_fits,
	unix_path_limit,
};

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
	#[error(
		"Unix endpoint path is {bytes} bytes, over this platform's {limit}-byte limit, and a client \
		 cannot connect to it: {path}"
	)]
	UnixPathTooLong { path: String, bytes: usize, limit: usize },
	#[error(
		"No GUI host socket path fits this platform's {limit}-byte limit: tried {tried}. A client \
		 cannot connect to a longer path. Set XDG_RUNTIME_DIR to a short directory, or pass an \
		 explicit endpoint: --endpoint unix:/short/path.sock"
	)]
	NoSocketPathFits { tried: String, limit: usize },
}

/// Environment variable naming the profile whose agent directory holds the
/// default socket.
pub const VEYYON_PROFILE_ENV: &str = "VEYYON_PROFILE";

/// Target socket connection descriptor for the desktop transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
	Unix { path: PathBuf },
	Tcp { host: String, port: u16 },
}

impl Endpoint {
	/// Constructs the default unix endpoint for a given agent directory.
	pub fn default_unix(agent_dir: &Path) -> Result<Self, EndpointError> {
		Ok(Self::Unix { path: gui_host_socket_path(agent_dir)? })
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
			let path = PathBuf::from(socket_path);
			check_unix_path(&path)?;
			return Ok(Self::Unix { path });
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

		// Fallback to the default socket, which the host's own rule mirrors.
		match default_agent_dir {
			Some(dir) => Self::default_unix(dir),
			None => Ok(Self::Unix { path: PathBuf::from(DEFAULT_SOCKET_FILENAME) }),
		}
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

		Self::default_unix(agent_dir)
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

/// Errors from resolving where the window attaches.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AttachError {
	#[error(transparent)]
	Endpoint(#[from] EndpointError),
	#[error(
		"no home directory, so no default socket; pass --endpoint or set {VEYYON_GUI_ENDPOINT_ENV}"
	)]
	NoAgentDir,
}

/// The target endpoint and the outcome of starting a host when required.
/// A startup failure does not prevent transport retries against the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
	pub endpoint: Endpoint,
	pub spawned:  Result<Option<ChildHostHandle>, HostSpawnError>,
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
		return Ok(Attachment { endpoint, spawned: Ok(None) });
	}

	let agent_dir = agent_dir.ok_or(AttachError::NoAgentDir)?;
	let endpoint = Endpoint::default_unix(&agent_dir)?;
	if accepts_connection(&endpoint) {
		return Ok(Attachment { endpoint, spawned: Ok(None) });
	}
	let spawned = spawn_child_host(cwd);
	let endpoint = match &spawned {
		Ok(child) => child.endpoint.clone(),
		Err(HostSpawnError::NotListening { endpoint, .. }) => endpoint.clone(),
		Err(_) => endpoint,
	};
	Ok(Attachment { endpoint, spawned: spawned.map(Some) })
}
