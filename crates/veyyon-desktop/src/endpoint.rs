use std::{
	fmt,
	path::{Path, PathBuf},
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

/// Errors encountered while spawning a child host process.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum HostSpawnError {
	#[error("Child host process spawning is not implemented in this phase")]
	NotImplemented,
	#[error("Failed to spawn child host process in directory '{0}': {1}")]
	SpawnFailed(PathBuf, String),
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

/// Placeholder handle for a spawned child host process.
#[derive(Debug)]
pub struct ChildHostHandle {
	pub endpoint: Endpoint,
}

/// Named function boundary for spawning a child GUI host process (`veyyon
/// gui`).
///
/// Note: Child process spawning is reserved for the subsequent application
/// lifecycle phase.
pub const fn spawn_child_host(agent_dir: &Path) -> Result<ChildHostHandle, HostSpawnError> {
	let _ = agent_dir;
	Err(HostSpawnError::NotImplemented)
}
