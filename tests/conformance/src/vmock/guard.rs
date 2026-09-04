//! Network-deny guard for asserting loopback-only connections.
//!
//! # Observability Scope
//!
//! The [`NetworkDenyGuard`] asserts that client connections and configured base
//! URLs target only the designated loopback [`std::net::SocketAddr`] assigned
//! to the test [`crate::vmock::Engine`].
//!
//! **Important Boundary Note:** The guard can observe and validate connections,
//! URLs, and endpoints explicitly registered with or routed through the
//! conformance harness. It cannot intercept or observe arbitrary out-of-band
//! raw OS socket syscalls that bypass configured harness endpoints.

use std::{
	fmt,
	net::{IpAddr, Ipv4Addr, SocketAddr},
	sync::{Arc, Mutex},
};

/// Error indicating an attempted connection to a disallowed non-loopback
/// destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DenyViolation {
	/// The disallowed destination that was attempted.
	pub destination: String,
	/// The allowed loopback address.
	pub allowed:     SocketAddr,
	/// Detailed explanation.
	pub reason:      String,
}

impl fmt::Display for DenyViolation {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			f,
			"Network deny violation: attempted connection to disallowed destination '{}' (only '{}' \
			 is permitted): {}",
			self.destination, self.allowed, self.reason
		)
	}
}

impl std::error::Error for DenyViolation {}

/// Guard that validates network destinations against the allowed loopback
/// address.
#[derive(Debug, Clone)]
pub struct NetworkDenyGuard {
	allowed:    SocketAddr,
	violations: Arc<Mutex<Vec<String>>>,
}

impl NetworkDenyGuard {
	/// Create a new guard permitting only `allowed`.
	#[must_use]
	pub fn new(allowed: SocketAddr) -> Self {
		Self { allowed, violations: Arc::new(Mutex::new(Vec::new())) }
	}

	/// The allowed loopback socket address.
	#[must_use]
	pub const fn allowed_addr(&self) -> SocketAddr {
		self.allowed
	}

	/// Check whether a destination socket address is allowed.
	///
	/// # Errors
	///
	/// Returns [`DenyViolation`] if `addr` does not match the allowed loopback
	/// address.
	pub fn check_addr(&self, addr: SocketAddr) -> Result<(), DenyViolation> {
		if addr == self.allowed {
			Ok(())
		} else {
			let reason = if addr.ip().is_loopback() {
				format!("loopback address with unexpected port {}", addr.port())
			} else {
				format!("non-loopback IP address {}", addr.ip())
			};
			let violation =
				DenyViolation { destination: addr.to_string(), allowed: self.allowed, reason };
			if let Ok(mut lock) = self.violations.lock() {
				lock.push(addr.to_string());
			}
			Err(violation)
		}
	}

	/// Check whether a destination string (URL, host:port, or IP:port) is
	/// allowed.
	///
	/// # Errors
	///
	/// Returns [`DenyViolation`] if the destination does not match the allowed
	/// address.
	pub fn check_destination(&self, dest: &str) -> Result<(), DenyViolation> {
		let parsed = parse_dest_to_socket_addr(dest, self.allowed.port());
		match parsed {
			Ok(addr) => self.check_addr(addr),
			Err(reason) => {
				let violation =
					DenyViolation { destination: dest.to_string(), allowed: self.allowed, reason };
				if let Ok(mut lock) = self.violations.lock() {
					lock.push(dest.to_string());
				}
				Err(violation)
			},
		}
	}

	/// Record an explicit violation observed by the harness.
	pub fn record_violation(&self, dest: impl Into<String>) {
		if let Ok(mut lock) = self.violations.lock() {
			lock.push(dest.into());
		}
	}

	/// Returns all recorded violations.
	#[must_use]
	pub fn violations(&self) -> Vec<String> {
		self
			.violations
			.lock()
			.map_or_else(|_| Vec::new(), |l| l.clone())
	}

	/// Assert that no violations were recorded.
	///
	/// # Errors
	///
	/// Returns [`DenyViolation`] naming the first recorded violation if any
	/// occurred.
	pub fn assert_no_violations(&self) -> Result<(), DenyViolation> {
		let list = self.violations();
		if let Some(first) = list.first() {
			Err(DenyViolation {
				destination: first.clone(),
				allowed:     self.allowed,
				reason:      format!("{} network deny violation(s) recorded", list.len()),
			})
		} else {
			Ok(())
		}
	}
}

fn parse_dest_to_socket_addr(dest: &str, default_port: u16) -> Result<SocketAddr, String> {
	let trimmed = dest.trim();
	let without_scheme = if let Some(stripped) = trimmed.strip_prefix("http://") {
		stripped
	} else if let Some(stripped) = trimmed.strip_prefix("https://") {
		stripped
	} else {
		trimmed
	};

	let host_port = without_scheme.split('/').next().unwrap_or(without_scheme);

	if let Ok(addr) = host_port.parse::<SocketAddr>() {
		return Ok(addr);
	}

	if let Some((host, port_str)) = host_port.rsplit_once(':') {
		let port = port_str
			.parse::<u16>()
			.map_err(|e| format!("invalid port in '{dest}': {e}"))?;
		if host == "localhost" || host == "127.0.0.1" {
			Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
		} else {
			Err(format!("disallowed host '{host}'"))
		}
	} else if host_port == "localhost" || host_port == "127.0.0.1" {
		Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), default_port))
	} else {
		Err(format!("disallowed non-loopback destination '{dest}'"))
	}
}
