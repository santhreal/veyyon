//! Hand-written HTTP/1.1 parser and serializer for byte-exact wire control.

use std::{fmt, str::Utf8Error};

use bytes::{Bytes, BytesMut};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::vmock::script::{ResponseScript, WireChunk};

/// HTTP/1.1 parsing errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpParseError {
	/// Connection closed before receiving complete request line / headers.
	UnexpectedEof,
	/// Request line was malformed.
	MalformedRequestLine(String),
	/// Header line was malformed.
	MalformedHeader(String),
	/// Content-Length header contained an invalid number.
	InvalidContentLength(String),
	/// Chunked body encoding was malformed.
	MalformedChunkedBody(String),
	/// Request headers exceeded the safety limit (64 KiB).
	HeadersTooLarge,
}

impl fmt::Display for HttpParseError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::UnexpectedEof => write!(f, "unexpected EOF while parsing HTTP request"),
			Self::MalformedRequestLine(s) => write!(f, "malformed request line: {s}"),
			Self::MalformedHeader(s) => write!(f, "malformed header: {s}"),
			Self::InvalidContentLength(s) => write!(f, "invalid Content-Length: {s}"),
			Self::MalformedChunkedBody(s) => write!(f, "malformed chunked body: {s}"),
			Self::HeadersTooLarge => write!(f, "headers exceeded maximum size limit"),
		}
	}
}

impl std::error::Error for HttpParseError {}

/// A parsed HTTP request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
	/// HTTP method in uppercase (e.g. "GET", "POST").
	pub method:  String,
	/// Request target URI / path (e.g. "/v1/chat/completions").
	pub path:    String,
	/// HTTP protocol version (e.g. "HTTP/1.1").
	pub version: String,
	/// Request headers as (Name, Value) pairs.
	pub headers: Vec<(String, String)>,
	/// Request body bytes.
	pub body:    Bytes,
}

impl HttpRequest {
	/// Get the value of the first header matching `name` (case-insensitive).
	#[must_use]
	pub fn header(&self, name: &str) -> Option<&str> {
		self
			.headers
			.iter()
			.find(|(k, _)| k.eq_ignore_ascii_case(name))
			.map(|(_, v)| v.as_str())
	}

	/// Get the request body as a UTF-8 string slice.
	///
	/// # Errors
	///
	/// Returns [`Utf8Error`] if the body contains invalid UTF-8 bytes.
	pub fn body_str(&self) -> Result<&str, Utf8Error> {
		std::str::from_utf8(&self.body)
	}

	/// Returns whether the client requested connection keep-alive.
	#[must_use]
	pub fn is_keep_alive(&self) -> bool {
		if let Some(conn) = self.header("connection") {
			if conn.eq_ignore_ascii_case("close") {
				return false;
			}
			if conn.eq_ignore_ascii_case("keep-alive") {
				return true;
			}
		}
		// HTTP/1.1 defaults to keep-alive; HTTP/1.0 defaults to close
		self.version == "HTTP/1.1"
	}
}

/// Buffer reading helper that parses incoming HTTP/1.1 requests from a stream.
pub struct HttpReader {
	buffer: BytesMut,
}

impl Default for HttpReader {
	fn default() -> Self {
		Self::new()
	}
}

impl HttpReader {
	/// Create a new HTTP reader with an empty buffer.
	#[must_use]
	pub fn new() -> Self {
		Self { buffer: BytesMut::with_capacity(8192) }
	}

	/// Read and parse one HTTP request from `stream`.
	///
	/// Returns `Ok(None)` on clean EOF before any bytes of a new request arrive.
	///
	/// # Errors
	///
	/// Returns [`HttpParseError`] if the request syntax is malformed or invalid.
	pub async fn read_request<S>(
		&mut self,
		stream: &mut S,
	) -> Result<Option<HttpRequest>, HttpParseError>
	where
		S: AsyncReadExt + Unpin,
	{
		// 1. Read until headers delimiter \r\n\r\n is in the buffer
		let header_end_pos = loop {
			if let Some(pos) = find_header_end(&self.buffer) {
				break pos;
			}
			if self.buffer.len() > 65536 {
				return Err(HttpParseError::HeadersTooLarge);
			}
			let mut chunk = [0u8; 4096];
			let n = stream
				.read(&mut chunk)
				.await
				.map_err(|_| HttpParseError::UnexpectedEof)?;
			if n == 0 {
				if self.buffer.is_empty() {
					return Ok(None);
				}
				return Err(HttpParseError::UnexpectedEof);
			}
			self.buffer.extend_from_slice(&chunk[..n]);
		};

		// 2. Parse request line and headers
		let header_bytes = self.buffer.split_to(header_end_pos);
		// Consume the \r\n\r\n delimiter from self.buffer
		let _delimiter = self.buffer.split_to(4);

		let header_str = std::str::from_utf8(&header_bytes)
			.map_err(|_| HttpParseError::MalformedHeader("invalid utf-8 in headers".into()))?;

		let mut lines = header_str.split("\r\n");
		let request_line = lines
			.next()
			.ok_or_else(|| HttpParseError::MalformedRequestLine("empty request line".into()))?;

		let mut parts = request_line.split_whitespace();
		let method = parts
			.next()
			.ok_or_else(|| HttpParseError::MalformedRequestLine("missing method".into()))?
			.to_ascii_uppercase();
		let path = parts
			.next()
			.ok_or_else(|| HttpParseError::MalformedRequestLine("missing path".into()))?
			.to_string();
		let version = parts
			.next()
			.ok_or_else(|| HttpParseError::MalformedRequestLine("missing version".into()))?
			.to_ascii_uppercase();

		if version != "HTTP/1.1" && version != "HTTP/1.0" {
			return Err(HttpParseError::MalformedRequestLine(format!(
				"unsupported HTTP version '{version}'"
			)));
		}

		let mut headers = Vec::new();
		for line in lines {
			if line.is_empty() {
				continue;
			}
			if let Some((name, val)) = line.split_once(':') {
				headers.push((name.trim().to_string(), val.trim().to_string()));
			} else {
				return Err(HttpParseError::MalformedHeader(line.to_string()));
			}
		}

		// 3. Determine and read body
		let is_chunked = headers.iter().any(|(k, v)| {
			k.eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked")
		});

		let content_length = headers
			.iter()
			.find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
			.map(|(_, v)| {
				v.parse::<usize>()
					.map_err(|_| HttpParseError::InvalidContentLength(v.clone()))
			})
			.transpose()?;

		let body = if is_chunked {
			self.read_chunked_body(stream).await?
		} else if let Some(len) = content_length {
			self.read_fixed_body(stream, len).await?
		} else {
			Bytes::new()
		};

		Ok(Some(HttpRequest { method, path, version, headers, body }))
	}

	async fn read_fixed_body<S>(
		&mut self,
		stream: &mut S,
		len: usize,
	) -> Result<Bytes, HttpParseError>
	where
		S: AsyncReadExt + Unpin,
	{
		while self.buffer.len() < len {
			let mut chunk = [0u8; 4096];
			let n = stream
				.read(&mut chunk)
				.await
				.map_err(|_| HttpParseError::UnexpectedEof)?;
			if n == 0 {
				return Err(HttpParseError::UnexpectedEof);
			}
			self.buffer.extend_from_slice(&chunk[..n]);
		}
		let body_bytes = self.buffer.split_to(len);
		Ok(body_bytes.freeze())
	}

	async fn read_chunked_body<S>(&mut self, stream: &mut S) -> Result<Bytes, HttpParseError>
	where
		S: AsyncReadExt + Unpin,
	{
		let mut accumulated = BytesMut::new();
		loop {
			// Find CRLF line for chunk size
			let crlf_pos = loop {
				if let Some(pos) = find_crlf(&self.buffer) {
					break pos;
				}
				let mut chunk = [0u8; 4096];
				let n = stream
					.read(&mut chunk)
					.await
					.map_err(|_| HttpParseError::UnexpectedEof)?;
				if n == 0 {
					return Err(HttpParseError::UnexpectedEof);
				}
				self.buffer.extend_from_slice(&chunk[..n]);
			};

			let size_line_bytes = self.buffer.split_to(crlf_pos);
			let _crlf = self.buffer.split_to(2);

			let size_str = std::str::from_utf8(&size_line_bytes).map_err(|_| {
				HttpParseError::MalformedChunkedBody("invalid utf-8 in chunk size".into())
			})?;
			let hex_part = size_str.split(';').next().unwrap_or("").trim();
			let chunk_len = usize::from_str_radix(hex_part, 16).map_err(|_| {
				HttpParseError::MalformedChunkedBody(format!("invalid chunk hex size '{hex_part}'"))
			})?;

			if chunk_len == 0 {
				// Trailing chunk. Read until ending empty line (\r\n)
				loop {
					if self.buffer.starts_with(b"\r\n") {
						let _ = self.buffer.split_to(2);
						break;
					}
					if let Some(pos) = find_crlf(&self.buffer) {
						let _line = self.buffer.split_to(pos);
						let _ = self.buffer.split_to(2);
					} else {
						let mut chunk = [0u8; 512];
						let n = stream
							.read(&mut chunk)
							.await
							.map_err(|_| HttpParseError::UnexpectedEof)?;
						if n == 0 {
							break;
						}
						self.buffer.extend_from_slice(&chunk[..n]);
					}
				}
				break;
			}

			// Read chunk_len bytes + \r\n
			while self.buffer.len() < chunk_len + 2 {
				let mut chunk = [0u8; 4096];
				let n = stream
					.read(&mut chunk)
					.await
					.map_err(|_| HttpParseError::UnexpectedEof)?;
				if n == 0 {
					return Err(HttpParseError::UnexpectedEof);
				}
				self.buffer.extend_from_slice(&chunk[..n]);
			}

			let chunk_data = self.buffer.split_to(chunk_len);
			let _chunk_crlf = self.buffer.split_to(2);
			accumulated.extend_from_slice(&chunk_data);
		}

		Ok(accumulated.freeze())
	}
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
	buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn find_crlf(buf: &[u8]) -> Option<usize> {
	buf.windows(2).position(|w| w == b"\r\n")
}

/// Action to take on the connection after executing a response script.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionAction {
	/// Keep connection open for subsequent requests (HTTP keep-alive).
	KeepAlive,
	/// Close the TCP connection cleanly.
	Close,
	/// Drop connection immediately without flushing.
	Dropped,
}

/// Write a scripted response to `stream`.
///
/// # Errors
///
/// Returns an I/O error if writing to the underlying TCP stream fails.
pub async fn write_response<S>(
	stream: &mut S,
	script: &ResponseScript,
	keep_alive: bool,
) -> Result<ConnectionAction, std::io::Error>
where
	S: AsyncWriteExt + Unpin,
{
	// 1. Build and write status line and headers
	let mut header_buf = Vec::with_capacity(512);
	header_buf
		.extend_from_slice(format!("HTTP/1.1 {} {}\r\n", script.status, script.reason).as_bytes());

	let mut has_connection_header = false;
	for (name, val) in &script.headers {
		if name.eq_ignore_ascii_case("connection") {
			has_connection_header = true;
		}
		header_buf.extend_from_slice(format!("{name}: {val}\r\n").as_bytes());
	}

	if !has_connection_header {
		if keep_alive {
			header_buf.extend_from_slice(b"Connection: keep-alive\r\n");
		} else {
			header_buf.extend_from_slice(b"Connection: close\r\n");
		}
	}

	header_buf.extend_from_slice(b"\r\n");
	stream.write_all(&header_buf).await?;
	stream.flush().await?;

	// 2. Deliver wire chunks
	for chunk in &script.chunks {
		match chunk {
			WireChunk::Bytes(b) => {
				stream.write_all(b).await?;
				stream.flush().await?;
			},
			WireChunk::Delay(duration) => {
				tokio::time::sleep(*duration).await;
			},
			WireChunk::HardClose => {
				return Ok(ConnectionAction::Dropped);
			},
			WireChunk::IdleStall => {
				// Stall indefinitely until caller cancels or times out
				std::future::pending::<()>().await;
			},
			WireChunk::H2ResetStream(_) | WireChunk::H2GoAway(_) => {
				return Ok(ConnectionAction::Close);
			},
		}
	}

	if keep_alive && !has_connection_close(&script.headers) {
		Ok(ConnectionAction::KeepAlive)
	} else {
		Ok(ConnectionAction::Close)
	}
}

/// Write a 400 Bad Request error response and close connection.
///
/// # Errors
///
/// Returns an I/O error if writing to `stream` fails.
pub async fn write_bad_request<S>(stream: &mut S, reason: &str) -> Result<(), std::io::Error>
where
	S: AsyncWriteExt + Unpin,
{
	let body = format!("400 Bad Request: {reason}\n");
	let resp = format!(
		"HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: \
		 close\r\nContent-Length: {}\r\n\r\n{body}",
		body.len()
	);
	stream.write_all(resp.as_bytes()).await?;
	stream.flush().await?;
	Ok(())
}

fn has_connection_close(headers: &[(String, String)]) -> bool {
	headers
		.iter()
		.any(|(k, v)| k.eq_ignore_ascii_case("connection") && v.eq_ignore_ascii_case("close"))
}
