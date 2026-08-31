//! One socket over the two address families, so the session has one shape.
//!
//! Reading blocks, which is what a reader thread wants and what makes stopping
//! a problem: a thread parked in `read` does not notice a flag. Every socket is
//! therefore cloneable and shuttable, and stopping is a shutdown on the clone
//! rather than a flag the parked thread cannot see.

#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::{
	io::{self, Read, Write},
	net::TcpStream,
};

use super::endpoint::Endpoint;

/// A connected socket.
pub enum Socket {
	#[cfg(unix)]
	Unix(UnixStream),
	Tcp(TcpStream),
}

impl Socket {
	/// Connect to the endpoint as written.
	pub fn connect(endpoint: &Endpoint) -> io::Result<Self> {
		match endpoint {
			#[cfg(unix)]
			Endpoint::Unix(path) => UnixStream::connect(path).map(Self::Unix),
			#[cfg(not(unix))]
			Endpoint::Unix(path) => Err(io::Error::new(
				io::ErrorKind::Unsupported,
				format!("this build reaches no unix socket, and {} is one", path.display()),
			)),
			Endpoint::Tcp(authority) => TcpStream::connect(authority).map(Self::Tcp),
		}
	}

	/// A second handle on the same connection, for the writer and for shutdown.
	pub fn try_clone(&self) -> io::Result<Self> {
		match self {
			#[cfg(unix)]
			Self::Unix(stream) => stream.try_clone().map(Self::Unix),
			Self::Tcp(stream) => stream.try_clone().map(Self::Tcp),
		}
	}

	/// End the connection in both directions, which unparks a blocked read.
	pub fn shutdown(&self) {
		let _ = match self {
			#[cfg(unix)]
			Self::Unix(stream) => stream.shutdown(std::net::Shutdown::Both),
			Self::Tcp(stream) => stream.shutdown(std::net::Shutdown::Both),
		};
	}
}

impl Read for Socket {
	fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
		match self {
			#[cfg(unix)]
			Self::Unix(stream) => stream.read(buffer),
			Self::Tcp(stream) => stream.read(buffer),
		}
	}
}

impl Write for Socket {
	fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
		match self {
			#[cfg(unix)]
			Self::Unix(stream) => stream.write(buffer),
			Self::Tcp(stream) => stream.write(buffer),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			#[cfg(unix)]
			Self::Unix(stream) => stream.flush(),
			Self::Tcp(stream) => stream.flush(),
		}
	}
}
