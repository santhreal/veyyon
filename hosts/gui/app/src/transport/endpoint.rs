//! Where the engine is, as written by whoever started the window.
//!
//! Two forms, because the two cases are different: a local engine on the same
//! machine is a unix socket, and an engine reached over a tunnel or a container
//! boundary is a TCP address. The string is what
//! [`ConnectionState::Connected`](veyyon_gui_core::model::ConnectionState)
//! shows the reader, so it round-trips: what is parsed is what is displayed.

use std::{fmt, path::PathBuf};

/// The environment key naming the engine. Absent means detached, which is a
/// state the window draws rather than an error.
pub const ENDPOINT_ENV: &str = "VEYYON_GUI_ENDPOINT";

/// A parsed engine address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
	/// A unix domain socket at this path.
	Unix(PathBuf),
	/// A TCP authority, host and port as written.
	Tcp(String),
}

/// Why a written endpoint is not an address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointError {
	/// No scheme prefix, so there is nothing to resolve.
	NoScheme,
	/// A scheme this build does not speak.
	UnknownScheme(String),
	/// The scheme was right and the rest was empty.
	Empty(&'static str),
	/// A TCP authority with no port, which cannot be connected to.
	NoPort(String),
}

impl fmt::Display for EndpointError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::NoScheme => write!(formatter, "an endpoint starts with unix: or tcp:"),
			Self::UnknownScheme(scheme) => {
				write!(formatter, "{scheme}: is not a scheme this build speaks")
			},
			Self::Empty(scheme) => write!(formatter, "{scheme}: was given nothing to connect to"),
			Self::NoPort(authority) => write!(formatter, "{authority} states no port"),
		}
	}
}

impl Endpoint {
	/// Parse an endpoint as written: `unix:/run/veyyon.sock` or
	/// `tcp:127.0.0.1:7654`.
	pub fn parse(written: &str) -> Result<Self, EndpointError> {
		let trimmed = written.trim();
		let Some((scheme, rest)) = trimmed.split_once(':') else {
			return Err(EndpointError::NoScheme);
		};
		match scheme {
			"unix" => {
				if rest.is_empty() {
					return Err(EndpointError::Empty("unix"));
				}
				Ok(Self::Unix(PathBuf::from(rest)))
			},
			"tcp" => {
				if rest.is_empty() {
					return Err(EndpointError::Empty("tcp"));
				}
				let port = rest
					.rsplit_once(':')
					.map(|(_, port)| port)
					.unwrap_or_default();
				if port.is_empty() || port.parse::<u16>().is_err() {
					return Err(EndpointError::NoPort(rest.to_owned()));
				}
				Ok(Self::Tcp(rest.to_owned()))
			},
			other => Err(EndpointError::UnknownScheme(other.to_owned())),
		}
	}

	/// The endpoint the environment names, or nothing when the window is meant
	/// to open detached.
	pub fn from_environment() -> Option<Result<Self, EndpointError>> {
		let written = std::env::var(ENDPOINT_ENV).ok()?;
		if written.trim().is_empty() {
			return None;
		}
		Some(Self::parse(&written))
	}
}

impl fmt::Display for Endpoint {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Unix(path) => write!(formatter, "unix:{}", path.display()),
			Self::Tcp(authority) => write!(formatter, "tcp:{authority}"),
		}
	}
}
