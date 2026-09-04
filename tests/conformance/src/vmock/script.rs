//! Scripted response programmes for byte-exact wire delivery.

use std::time::Duration;

use bytes::Bytes;

use crate::vmock::fault::FaultKind;

/// An atomic action performed on the TCP connection wire during response
/// delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireChunk {
	/// Write raw bytes to the TCP stream.
	Bytes(Bytes),
	/// Pause execution for the specified duration before subsequent operations.
	Delay(Duration),
	/// Immediately close the TCP stream abruptly mid-stream (`ECONNRESET`-like
	/// drop).
	HardClose,
	/// Stall the connection indefinitely without writing further bytes.
	IdleStall,
	/// Emit an HTTP/2 `RST_STREAM` frame carrying the given error reason.
	H2ResetStream(h2::Reason),
	/// Emit an HTTP/2 `GOAWAY` frame carrying the given error reason and close
	/// the connection.
	H2GoAway(h2::Reason),
}

/// A scripted response programme for a route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseScript {
	/// HTTP response status code (e.g. 200, 401, 429, 500).
	pub status:  u16,
	/// HTTP status reason phrase (e.g. "OK", "Unauthorized").
	pub reason:  String,
	/// Response headers to deliver.
	pub headers: Vec<(String, String)>,
	/// Wire operations to execute in order.
	pub chunks:  Vec<WireChunk>,
}

impl ResponseScript {
	/// Create a new response script with the given HTTP status code and default
	/// reason phrase.
	#[must_use]
	pub fn new(status: u16) -> Self {
		let reason = default_reason_phrase(status).to_string();
		Self { status, reason, headers: Vec::new(), chunks: Vec::new() }
	}

	/// Create an HTTP 200 OK response script.
	#[must_use]
	pub fn ok() -> Self {
		Self::new(200).header("Content-Type", "application/json")
	}

	/// Create an HTTP 200 Server-Sent Events response script.
	#[must_use]
	pub fn sse() -> Self {
		Self::new(200)
			.header("Content-Type", "text/event-stream")
			.header("Cache-Control", "no-cache")
			.header("Connection", "keep-alive")
	}

	/// Create an SSE response script chunked at exactly `chunk_size` bytes per
	/// write.
	///
	/// `chunk_size` is clamped between 1 and 1024 bytes per write.
	#[must_use]
	pub fn sse_stream(raw_sse_bytes: &[u8], chunk_size: usize) -> Self {
		let effective_chunk_size = chunk_size.clamp(1, 1024);
		let mut script = Self::sse();
		for chunk in raw_sse_bytes.chunks(effective_chunk_size) {
			script = script.chunk(Bytes::copy_from_slice(chunk));
		}
		script
	}

	/// Create an SSE response script from a list of formatted SSE event
	/// payloads.
	#[must_use]
	pub fn sse_events(events: &[&str], chunk_size: usize) -> Self {
		let mut full_body = Vec::new();
		for event in events {
			if event.starts_with("data:") || event.starts_with("event:") || event.starts_with(':') {
				full_body.extend_from_slice(event.as_bytes());
				if !event.ends_with("\n\n") {
					if event.ends_with('\n') {
						full_body.push(b'\n');
					} else {
						full_body.extend_from_slice(b"\n\n");
					}
				}
			} else {
				full_body.extend_from_slice(b"data: ");
				full_body.extend_from_slice(event.as_bytes());
				full_body.extend_from_slice(b"\n\n");
			}
		}
		Self::sse_stream(&full_body, chunk_size)
	}

	/// Create a scripted response from a predefined [`FaultKind`].
	#[must_use]
	pub fn from_fault(fault: FaultKind) -> Self {
		match fault {
			FaultKind::MidStreamDrop => Self::sse()
				.chunk(Bytes::from_static(
					b"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\"}}\n\n",
				))
				.chunk(Bytes::from_static(
					b"data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"partial token payload that will be dro",
				))
				.hard_close(),

			FaultKind::IdleStall => Self::sse().stall(),

			FaultKind::Http401 => Self::new(401)
				.header("Content-Type", "application/json")
				.raw_body(Bytes::from_static(
					b"{\"error\":{\"message\":\"Invalid API key\",\"type\":\"authentication_error\",\"code\":\"invalid_api_key\"}}",
				)),

			FaultKind::Http429 => Self::new(429)
				.header("Content-Type", "application/json")
				.header("Retry-After", "5")
				.raw_body(Bytes::from_static(
					b"{\"error\":{\"message\":\"Rate limit exceeded\",\"type\":\"rate_limit_error\",\"code\":\"rate_limit_exceeded\"}}",
				)),

			FaultKind::Http500 => Self::new(500)
				.header("Content-Type", "application/json")
				.raw_body(Bytes::from_static(
					b"{\"error\":{\"message\":\"Internal server error\",\"type\":\"server_error\"}}",
				)),

			FaultKind::Http503 => Self::new(503)
				.header("Content-Type", "application/json")
				.raw_body(Bytes::from_static(
					b"{\"error\":{\"message\":\"Service unavailable\",\"type\":\"service_unavailable\"}}",
				)),

			FaultKind::TruncatedJson => Self::sse().chunk(Bytes::from_static(
				b"data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"hello world\n\n",
			)),

			FaultKind::InvalidUtf8 => {
				Self::sse().chunk(Bytes::from_static(b"data: \xFF\xFE\xFD invalid utf8 sequence\n\n"))
			}

			FaultKind::UnterminatedEvent => Self::sse().chunk(Bytes::from_static(
				b"data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"unterminated\"}}\n",
			)),

			FaultKind::UnexpectedThinkingBlock => Self::sse().chunk(Bytes::from_static(
				b"data: {\"type\":\"thinking_delta\",\"thinking\":{\"corrupt_block\":[1,2,3]}}\n\n",
			)),
		}
	}

	/// Add a response header.
	#[must_use]
	pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
		self.headers.push((name.into(), value.into()));
		self
	}

	/// Append a raw byte chunk to the wire delivery script.
	#[must_use]
	pub fn chunk(mut self, data: impl Into<Bytes>) -> Self {
		self.chunks.push(WireChunk::Bytes(data.into()));
		self
	}

	/// Set the entire body as a single chunk with an explicit `Content-Length`
	/// header.
	#[must_use]
	pub fn raw_body(mut self, body: impl Into<Bytes>) -> Self {
		let b = body.into();
		self = self.header("Content-Length", b.len().to_string());
		self.chunks.push(WireChunk::Bytes(b));
		self
	}

	/// Append a pause to the wire delivery script.
	#[must_use]
	pub fn delay(mut self, duration: Duration) -> Self {
		self.chunks.push(WireChunk::Delay(duration));
		self
	}

	/// Append an abrupt connection drop to the wire delivery script.
	#[must_use]
	pub fn hard_close(mut self) -> Self {
		self.chunks.push(WireChunk::HardClose);
		self
	}

	/// Append an idle stall (indefinite pause) to the wire delivery script.
	#[must_use]
	pub fn stall(mut self) -> Self {
		self.chunks.push(WireChunk::IdleStall);
		self
	}

	/// Create an HTTP/2 `RST_STREAM` response script with the given reason.
	#[must_use]
	pub fn h2_reset(reason: h2::Reason) -> Self {
		let mut script = Self::new(200);
		script.chunks.push(WireChunk::H2ResetStream(reason));
		script
	}

	/// Create an HTTP/2 `GOAWAY` response script with the given reason.
	#[must_use]
	pub fn h2_goaway(reason: h2::Reason) -> Self {
		let mut script = Self::new(200);
		script.chunks.push(WireChunk::H2GoAway(reason));
		script
	}
}

const fn default_reason_phrase(status: u16) -> &'static str {
	match status {
		200 => "OK",
		201 => "Created",
		204 => "No Content",
		400 => "Bad Request",
		401 => "Unauthorized",
		403 => "Forbidden",
		404 => "Not Found",
		408 => "Request Timeout",
		409 => "Conflict",
		429 => "Too Many Requests",
		500 => "Internal Server Error",
		502 => "Bad Gateway",
		503 => "Service Unavailable",
		504 => "Gateway Timeout",
		_ => "Custom",
	}
}
