//! HTTP/2 (h2c) loopback server and transport fault engine.
//!
//! Implements HTTP/2 prior-knowledge (h2c) cleartext transport over loopback
//! TCP sockets, providing protocol-level request recording, scripted responses,
//! and fault injection for the 14 RFC 7540 / RFC 9113 `h2::Reason` error codes.
//!
//! # WHAT THIS DOES NOT CATCH
//!
//! While `vmock` verifies HTTP/2 (h2c) wire framing, multiplexing, client
//! connection preface verification, SETTINGS negotiation, flow control, and
//! transport-level error codes (`RST_STREAM` reasons and `GOAWAY` frames), it
//! treats all request and response payload bytes as opaque chunks.
//!
//! Specifically, `vmock` does **not** catch:
//! - Protobuf schema validation or wire-level protobuf encoding errors used by
//!   the Cursor provider.
//! - Cursor-specific RPC message envelope semantics or field numbers.
//! - Upstream Cursor service business logic or model output token structures.
//! - TLS / ALPN negotiation (Cursor in production may use TLS over port 443;
//!   this harness tests cleartext h2c with prior knowledge).

use std::{
	fmt,
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use bytes::{Bytes, BytesMut};
use http::{HeaderName, HeaderValue, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpStream, sync::mpsc, time::sleep};

use crate::vmock::{
	engine::{RouterState, router_guard},
	http::HttpRequest,
	script::{ResponseScript, WireChunk},
};

/// How long a handler lets a written frame reach the wire before it kills the
/// socket or the connection.
///
/// The `Connection` future is driven by the accept loop, in a different task
/// from the handler, so a handler that writes a DATA frame and immediately asks
/// for the socket to die can lose the frame it just wrote. Every drop fault is
/// about what the client saw BEFORE the connection died, so the write is given
/// time to land.
const FLUSH_SETTLE: Duration = Duration::from_millis(25);

/// How often a stalling fault re-checks the engine's shutdown flag.
const STALL_POLL: Duration = Duration::from_millis(100);

/// The 24-octet HTTP/2 client connection preface (RFC 7540 Section 3.5).
pub const H2_PREFACE: &[u8; 24] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

/// HTTP/2 error codes defined in RFC 7540 / RFC 9113 section 7.
///
/// Maps 1:1 to [`h2::Reason`] and the 14 `NGHTTP2_*` error codes classified by
/// `packages/utils/src/fetch-retry.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum H2Reason {
	/// `NO_ERROR` (0x0): Graceful shutdown or no error.
	NoError,
	/// `PROTOCOL_ERROR` (0x1): Protocol violation detected.
	ProtocolError,
	/// `INTERNAL_ERROR` (0x2): Internal processing error.
	InternalError,
	/// `FLOW_CONTROL_ERROR` (0x3): Flow control limits exceeded.
	FlowControlError,
	/// `SETTINGS_TIMEOUT` (0x4): Settings acknowledgment timed out.
	SettingsTimeout,
	/// `STREAM_CLOSED` (0x5): Frame received for closed stream.
	StreamClosed,
	/// `FRAME_SIZE_ERROR` (0x6): Frame size invalid for frame type.
	FrameSizeError,
	/// `REFUSED_STREAM` (0x7): Stream rejected before processing started.
	RefusedStream,
	/// `CANCEL` (0x8): Stream cancelled by sender.
	Cancel,
	/// `COMPRESSION_ERROR` (0x9): HPACK state decompression error.
	CompressionError,
	/// `CONNECT_ERROR` (0xa): Connection established for CONNECT failed.
	ConnectError,
	/// `ENHANCE_YOUR_CALM` (0xb): Rate or load limit exceeded.
	EnhanceYourCalm,
	/// `INADEQUATE_SECURITY` (0xc): Transport security requirements not met.
	InadequateSecurity,
	/// `HTTP_1_1_REQUIRED` (0xd): Server requires HTTP/1.1 for request.
	Http11Required,
}

impl H2Reason {
	/// All 14 standard RFC HTTP/2 error reasons in numerical code order.
	const ALL: [Self; 14] = [
		Self::NoError,
		Self::ProtocolError,
		Self::InternalError,
		Self::FlowControlError,
		Self::SettingsTimeout,
		Self::StreamClosed,
		Self::FrameSizeError,
		Self::RefusedStream,
		Self::Cancel,
		Self::CompressionError,
		Self::ConnectError,
		Self::EnhanceYourCalm,
		Self::InadequateSecurity,
		Self::Http11Required,
	];

	/// Every reason RFC 9113 section 7 defines, in code order.
	///
	/// The array is sized, so adding a variant is a compile error here and in
	/// every `match` below rather than a member the sweeps quietly skip.
	#[must_use]
	pub const fn all() -> &'static [Self; 14] {
		&Self::ALL
	}

	/// Convert to the corresponding [`h2::Reason`].
	#[must_use]
	pub const fn as_h2_reason(&self) -> h2::Reason {
		match self {
			Self::NoError => h2::Reason::NO_ERROR,
			Self::ProtocolError => h2::Reason::PROTOCOL_ERROR,
			Self::InternalError => h2::Reason::INTERNAL_ERROR,
			Self::FlowControlError => h2::Reason::FLOW_CONTROL_ERROR,
			Self::SettingsTimeout => h2::Reason::SETTINGS_TIMEOUT,
			Self::StreamClosed => h2::Reason::STREAM_CLOSED,
			Self::FrameSizeError => h2::Reason::FRAME_SIZE_ERROR,
			Self::RefusedStream => h2::Reason::REFUSED_STREAM,
			Self::Cancel => h2::Reason::CANCEL,
			Self::CompressionError => h2::Reason::COMPRESSION_ERROR,
			Self::ConnectError => h2::Reason::CONNECT_ERROR,
			Self::EnhanceYourCalm => h2::Reason::ENHANCE_YOUR_CALM,
			Self::InadequateSecurity => h2::Reason::INADEQUATE_SECURITY,
			Self::Http11Required => h2::Reason::HTTP_1_1_REQUIRED,
		}
	}

	/// Construct from an [`h2::Reason`] if recognised.
	#[must_use]
	pub const fn from_h2_reason(reason: h2::Reason) -> Option<Self> {
		match reason {
			h2::Reason::NO_ERROR => Some(Self::NoError),
			h2::Reason::PROTOCOL_ERROR => Some(Self::ProtocolError),
			h2::Reason::INTERNAL_ERROR => Some(Self::InternalError),
			h2::Reason::FLOW_CONTROL_ERROR => Some(Self::FlowControlError),
			h2::Reason::SETTINGS_TIMEOUT => Some(Self::SettingsTimeout),
			h2::Reason::STREAM_CLOSED => Some(Self::StreamClosed),
			h2::Reason::FRAME_SIZE_ERROR => Some(Self::FrameSizeError),
			h2::Reason::REFUSED_STREAM => Some(Self::RefusedStream),
			h2::Reason::CANCEL => Some(Self::Cancel),
			h2::Reason::COMPRESSION_ERROR => Some(Self::CompressionError),
			h2::Reason::CONNECT_ERROR => Some(Self::ConnectError),
			h2::Reason::ENHANCE_YOUR_CALM => Some(Self::EnhanceYourCalm),
			h2::Reason::INADEQUATE_SECURITY => Some(Self::InadequateSecurity),
			h2::Reason::HTTP_1_1_REQUIRED => Some(Self::Http11Required),
			_ => None,
		}
	}

	/// Returns whether this error is classified as retryable by
	/// `packages/utils/src/fetch-retry.ts`.
	#[must_use]
	pub const fn is_retryable(&self) -> bool {
		match self {
			Self::NoError
			| Self::ProtocolError
			| Self::InternalError
			| Self::SettingsTimeout
			| Self::StreamClosed
			| Self::RefusedStream
			| Self::ConnectError
			| Self::EnhanceYourCalm => true,
			Self::FlowControlError
			| Self::FrameSizeError
			| Self::Cancel
			| Self::CompressionError
			| Self::InadequateSecurity
			| Self::Http11Required => false,
		}
	}

	/// Returns the standard `NGHTTP2_*` identifier string.
	#[must_use]
	pub const fn as_str(&self) -> &'static str {
		match self {
			Self::NoError => "NGHTTP2_NO_ERROR",
			Self::ProtocolError => "NGHTTP2_PROTOCOL_ERROR",
			Self::InternalError => "NGHTTP2_INTERNAL_ERROR",
			Self::FlowControlError => "NGHTTP2_FLOW_CONTROL_ERROR",
			Self::SettingsTimeout => "NGHTTP2_SETTINGS_TIMEOUT",
			Self::StreamClosed => "NGHTTP2_STREAM_CLOSED",
			Self::FrameSizeError => "NGHTTP2_FRAME_SIZE_ERROR",
			Self::RefusedStream => "NGHTTP2_REFUSED_STREAM",
			Self::Cancel => "NGHTTP2_CANCEL",
			Self::CompressionError => "NGHTTP2_COMPRESSION_ERROR",
			Self::ConnectError => "NGHTTP2_CONNECT_ERROR",
			Self::EnhanceYourCalm => "NGHTTP2_ENHANCE_YOUR_CALM",
			Self::InadequateSecurity => "NGHTTP2_INADEQUATE_SECURITY",
			Self::Http11Required => "NGHTTP2_HTTP_1_1_REQUIRED",
		}
	}
}

impl fmt::Display for H2Reason {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

/// HTTP/2 transport fault injection variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum H2FaultKind {
	/// Stream error (`RST_STREAM`) carrying a chosen [`H2Reason`].
	StreamReset(H2Reason),
	/// Connection error (`GOAWAY`) carrying a chosen [`H2Reason`].
	ConnectionGoaway(H2Reason),
	/// Immediate `GOAWAY` delivered before any client request stream is created.
	PreStreamGoaway,
	/// Handshake stall where server never delivers initial SETTINGS frame.
	SettingsTimeout,
	/// Connection dropped abruptly mid-DATA frame delivery.
	MidDataDrop,
}

impl H2FaultKind {
	/// Complete list of all 31 HTTP/2 fault variants for exhaustive sweeps.
	pub const ALL: [Self; 31] = [
		Self::StreamReset(H2Reason::NoError),
		Self::StreamReset(H2Reason::ProtocolError),
		Self::StreamReset(H2Reason::InternalError),
		Self::StreamReset(H2Reason::FlowControlError),
		Self::StreamReset(H2Reason::SettingsTimeout),
		Self::StreamReset(H2Reason::StreamClosed),
		Self::StreamReset(H2Reason::FrameSizeError),
		Self::StreamReset(H2Reason::RefusedStream),
		Self::StreamReset(H2Reason::Cancel),
		Self::StreamReset(H2Reason::CompressionError),
		Self::StreamReset(H2Reason::ConnectError),
		Self::StreamReset(H2Reason::EnhanceYourCalm),
		Self::StreamReset(H2Reason::InadequateSecurity),
		Self::StreamReset(H2Reason::Http11Required),
		Self::ConnectionGoaway(H2Reason::NoError),
		Self::ConnectionGoaway(H2Reason::ProtocolError),
		Self::ConnectionGoaway(H2Reason::InternalError),
		Self::ConnectionGoaway(H2Reason::FlowControlError),
		Self::ConnectionGoaway(H2Reason::SettingsTimeout),
		Self::ConnectionGoaway(H2Reason::StreamClosed),
		Self::ConnectionGoaway(H2Reason::FrameSizeError),
		Self::ConnectionGoaway(H2Reason::RefusedStream),
		Self::ConnectionGoaway(H2Reason::Cancel),
		Self::ConnectionGoaway(H2Reason::CompressionError),
		Self::ConnectionGoaway(H2Reason::ConnectError),
		Self::ConnectionGoaway(H2Reason::EnhanceYourCalm),
		Self::ConnectionGoaway(H2Reason::InadequateSecurity),
		Self::ConnectionGoaway(H2Reason::Http11Required),
		Self::PreStreamGoaway,
		Self::SettingsTimeout,
		Self::MidDataDrop,
	];

	/// Returns all 31 fault variants.
	#[must_use]
	pub const fn all() -> &'static [Self; 31] {
		&Self::ALL
	}

	/// Returns a string identifier for this fault variant.
	#[must_use]
	pub const fn as_str(&self) -> &'static str {
		match self {
			Self::StreamReset(reason) => match reason {
				H2Reason::NoError => "stream-reset:NO_ERROR",
				H2Reason::ProtocolError => "stream-reset:PROTOCOL_ERROR",
				H2Reason::InternalError => "stream-reset:INTERNAL_ERROR",
				H2Reason::FlowControlError => "stream-reset:FLOW_CONTROL_ERROR",
				H2Reason::SettingsTimeout => "stream-reset:SETTINGS_TIMEOUT",
				H2Reason::StreamClosed => "stream-reset:STREAM_CLOSED",
				H2Reason::FrameSizeError => "stream-reset:FRAME_SIZE_ERROR",
				H2Reason::RefusedStream => "stream-reset:REFUSED_STREAM",
				H2Reason::Cancel => "stream-reset:CANCEL",
				H2Reason::CompressionError => "stream-reset:COMPRESSION_ERROR",
				H2Reason::ConnectError => "stream-reset:CONNECT_ERROR",
				H2Reason::EnhanceYourCalm => "stream-reset:ENHANCE_YOUR_CALM",
				H2Reason::InadequateSecurity => "stream-reset:INADEQUATE_SECURITY",
				H2Reason::Http11Required => "stream-reset:HTTP_1_1_REQUIRED",
			},
			Self::ConnectionGoaway(reason) => match reason {
				H2Reason::NoError => "goaway:NO_ERROR",
				H2Reason::ProtocolError => "goaway:PROTOCOL_ERROR",
				H2Reason::InternalError => "goaway:INTERNAL_ERROR",
				H2Reason::FlowControlError => "goaway:FLOW_CONTROL_ERROR",
				H2Reason::SettingsTimeout => "goaway:SETTINGS_TIMEOUT",
				H2Reason::StreamClosed => "goaway:STREAM_CLOSED",
				H2Reason::FrameSizeError => "goaway:FRAME_SIZE_ERROR",
				H2Reason::RefusedStream => "goaway:REFUSED_STREAM",
				H2Reason::Cancel => "goaway:CANCEL",
				H2Reason::CompressionError => "goaway:COMPRESSION_ERROR",
				H2Reason::ConnectError => "goaway:CONNECT_ERROR",
				H2Reason::EnhanceYourCalm => "goaway:ENHANCE_YOUR_CALM",
				H2Reason::InadequateSecurity => "goaway:INADEQUATE_SECURITY",
				H2Reason::Http11Required => "goaway:HTTP_1_1_REQUIRED",
			},
			Self::PreStreamGoaway => "pre-stream-goaway",
			Self::SettingsTimeout => "settings-timeout",
			Self::MidDataDrop => "mid-data-drop",
		}
	}
}

impl fmt::Display for H2FaultKind {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

/// A fault that lands before any request stream exists.
///
/// These two are not route behaviour: one withholds the server's own SETTINGS
/// frame so the handshake never completes, and the other writes `GOAWAY` the
/// moment it does. Neither can be expressed as a response to a request,
/// because at the point they act no request has been made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum H2ConnectionFault {
	/// Write `GOAWAY` as soon as the handshake completes, before any stream.
	PreStreamGoaway,
	/// Never complete the handshake: the server's SETTINGS frame is withheld.
	SettingsTimeout,
}

/// Where a [`H2FaultKind`] has to be installed to produce its failure.
///
/// A fault is either something a route answers with or something the
/// connection does before it answers anything, and the two are installed on
/// different objects. Returning the choice as a type is what stops a
/// connection-level fault being registered as a route script: the previous
/// spelling handed back a `ResponseScript` for every variant, so
/// `PreStreamGoaway` became a post-request `GOAWAY` and `SettingsTimeout`
/// became an idle stall — both observable, neither the fault named.
#[derive(Debug, Clone)]
pub enum H2FaultInstall {
	/// Install as the route's scripted response.
	Script(ResponseScript),
	/// Install on the connection, before any request.
	Connection(H2ConnectionFault),
}

/// The DATA frame a [`H2FaultKind::MidDataDrop`] writes before the socket dies.
///
/// Public because the assertion a mid-stream drop test makes is "the client
/// received exactly these bytes and then a broken connection", and a test that
/// spells the bytes itself is pinning a copy rather than the fault.
pub const MID_DATA_CHUNK: &[u8] = b"data: {\"init\":1}\n\n";

impl H2FaultKind {
	/// How this fault has to be installed to produce its failure.
	#[must_use]
	pub fn install(self) -> H2FaultInstall {
		match self {
			Self::StreamReset(reason) => {
				H2FaultInstall::Script(ResponseScript::h2_reset(reason.as_h2_reason()))
			},
			Self::ConnectionGoaway(reason) => {
				H2FaultInstall::Script(ResponseScript::h2_goaway(reason.as_h2_reason()))
			},
			Self::MidDataDrop => H2FaultInstall::Script(
				ResponseScript::sse()
					.chunk(Bytes::from_static(MID_DATA_CHUNK))
					.hard_close(),
			),
			Self::PreStreamGoaway => H2FaultInstall::Connection(H2ConnectionFault::PreStreamGoaway),
			Self::SettingsTimeout => H2FaultInstall::Connection(H2ConnectionFault::SettingsTimeout),
		}
	}
}

/// Peek incoming bytes on `stream` to determine if connection starts with the
/// HTTP/2 client connection preface.
///
/// Returns `Ok(Some(true))` for HTTP/2, `Ok(Some(false))` for HTTP/1.1, and
/// `Ok(None)` on immediate clean EOF.
///
/// # Errors
///
/// Returns an I/O error if peeking fails.
pub async fn sniff_is_h2(stream: &TcpStream) -> Result<Option<bool>, std::io::Error> {
	let mut buf = [0u8; 24];
	let n = stream.peek(&mut buf).await?;
	if n == 0 {
		return Ok(None);
	}
	// If the peeked bytes start with "PRI ", this is an attempted HTTP/2
	// connection.
	if (n >= 4 && &buf[..4] == b"PRI ") || buf[..n] == H2_PREFACE[..n] {
		Ok(Some(true))
	} else {
		Ok(Some(false))
	}
}

/// Why a scripted response could not be turned into HTTP/2 frames.
#[derive(Debug)]
pub enum ResponseError {
	/// A scripted header name or value is not valid in HTTP/2.
	InvalidHeader(String),
	/// A scripted status code is outside the range HTTP allows.
	InvalidStatus(u16),
	/// The peer rejected the response frames, or the connection is gone.
	Transport(h2::Error),
}

impl fmt::Display for ResponseError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::InvalidHeader(name) => write!(f, "invalid response header: {name}"),
			Self::InvalidStatus(status) => write!(f, "invalid response status: {status}"),
			Self::Transport(err) => write!(f, "transport rejected the response: {err}"),
		}
	}
}

impl std::error::Error for ResponseError {}

/// Header fields HTTP/2 forbids, which this transport removes.
///
/// RFC 9113 section 8.2.2: these carry HTTP/1.1 connection framing that has no
/// meaning in HTTP/2, and a server MUST remove them rather than forward one. A
/// `ResponseScript` is written once and served over both transports —
/// `ResponseScript::sse()` sets `Connection: keep-alive`, which is right for
/// HTTP/1.1 — so this is where the difference is resolved. Without it h2
/// rejects the whole response, the handler gives up before writing a byte, and
/// the client's stream ends as a cancellation that says nothing about why.
pub(crate) const CONNECTION_SPECIFIC_HEADERS: [&str; 5] =
	["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"];

/// Build the response head a scripted route answers with.
///
/// The types are named rather than inferred. The previous spelling reached
/// `http::Response` through a generic whose only job was to make inference
/// produce it (`default_response_for<B, R, F>(_f: F) -> R`), which existed to
/// avoid depending on `http` — a crate already in the lock file as `h2`'s own
/// dependency. It also dropped every header it could not parse on the floor,
/// so a scripted response and the response on the wire could differ with
/// nothing said about it.
fn build_response(
	status: u16,
	headers: &[(String, String)],
) -> Result<Response<()>, ResponseError> {
	let code = StatusCode::from_u16(status).map_err(|_| ResponseError::InvalidStatus(status))?;
	let mut response = Response::new(());
	*response.status_mut() = code;
	for (name, value) in headers {
		if CONNECTION_SPECIFIC_HEADERS
			.iter()
			.any(|forbidden| name.eq_ignore_ascii_case(forbidden))
		{
			continue;
		}
		let header_name = HeaderName::try_from(name.as_str())
			.map_err(|_| ResponseError::InvalidHeader(name.clone()))?;
		let header_value = HeaderValue::try_from(value.as_str())
			.map_err(|_| ResponseError::InvalidHeader(name.clone()))?;
		response.headers_mut().append(header_name, header_value);
	}
	Ok(response)
}

/// Send the response head, returning the stream its body frames go to.
fn send_h2_response(
	respond: &mut h2::server::SendResponse<Bytes>,
	status: u16,
	headers: &[(String, String)],
	end_of_stream: bool,
) -> Result<h2::SendStream<Bytes>, ResponseError> {
	let response = build_response(status, headers)?;
	respond
		.send_response(response, end_of_stream)
		.map_err(ResponseError::Transport)
}

/// Something only the task owning the `Connection` can do, asked for by a
/// stream handler.
///
/// A `GOAWAY` frame and the socket itself belong to the connection, not to one
/// stream. The previous spelling answered both by resetting the stream, which
/// made `H2GoAway` indistinguishable from `H2ResetStream` and `HardClose`
/// indistinguishable from `IdleStall` — and telling those apart is the whole
/// reason a retry classifier is worth verifying.
#[derive(Debug, Clone, Copy)]
enum PostAction {
	/// Write `GOAWAY` with this reason, then let the connection finish.
	Goaway(h2::Reason),
	/// Drop the socket with no frame explaining it.
	DropSocket,
}

/// Poll the connection until it finishes, bounded by [`FLUSH_SETTLE`].
///
/// `graceful_shutdown` and `abrupt_shutdown` only queue the `GOAWAY`; it
/// reaches the wire when the connection future is polled. Returning without
/// polling drops the socket with the frame still buffered, and the client then
/// observes a broken connection instead of the reason the fault names.
async fn drain(connection: &mut h2::server::Connection<TcpStream, Bytes>) {
	let _ =
		tokio::time::timeout(FLUSH_SETTLE, async { while connection.accept().await.is_some() {} })
			.await;
}

/// Hold the current position until the engine shuts down.
async fn stall(running: &AtomicBool) {
	while running.load(Ordering::Relaxed) {
		sleep(STALL_POLL).await;
	}
}

/// The scripted response for one request, or the engine default.
fn next_script(router: &Mutex<RouterState>, method: &str, path: &str) -> Option<ResponseScript> {
	let mut state = router_guard(router);
	let keyed = format!("{method} {path}");
	if let Some(handler) = state.routes.get_mut(&keyed) {
		handler.next_response()
	} else if let Some(handler) = state.routes.get_mut(path) {
		handler.next_response()
	} else {
		state.default_response.clone()
	}
}

/// Serve an HTTP/2 (h2c) connection.
pub(crate) async fn handle_h2_connection(
	stream: TcpStream,
	router: Arc<Mutex<RouterState>>,
	running: Arc<AtomicBool>,
) {
	let connection_fault = router_guard(&router).h2_fault;

	// A withheld SETTINGS frame is a handshake fault, so the handshake is never
	// started. The socket stays open: dropping it would be a connection error,
	// and what this fault is about is a client waiting for a frame that never
	// comes.
	if connection_fault == Some(H2ConnectionFault::SettingsTimeout) {
		stall(&running).await;
		return;
	}

	let Ok(mut connection) = h2::server::handshake(stream).await else {
		// Malformed preface, or the client left during the handshake.
		return;
	};

	if connection_fault == Some(H2ConnectionFault::PreStreamGoaway) {
		connection.graceful_shutdown();
		drain(&mut connection).await;
		return;
	}

	let (post_tx, mut post_rx) = mpsc::channel::<PostAction>(4);

	while running.load(Ordering::Relaxed) {
		// Both arms drive the connection: `accept` is what polls it, so a stream
		// handler's frames only move while this loop is inside the select.
		let action = tokio::select! {
			accepted = connection.accept() => {
				let Some(Ok((request, respond))) = accepted else { break };
				let method = request.method().to_string();
				let path = request.uri().path_and_query().map_or_else(
					|| request.uri().path().to_string(),
					ToString::to_string,
				);
				let script = next_script(&router, &method, &path);
				tokio::spawn(serve_h2_stream(
					request,
					respond,
					Arc::clone(&router),
					Arc::clone(&running),
					script,
					post_tx.clone(),
				));
				continue;
			},
			Some(action) = post_rx.recv() => action,
		};

		match action {
			PostAction::Goaway(reason) => {
				connection.abrupt_shutdown(reason);
				drain(&mut connection).await;
				return;
			},
			// Returning drops the connection, and with it the socket, with
			// nothing written to explain the loss.
			PostAction::DropSocket => return,
		}
	}
}

/// Serve one HTTP/2 request stream.
async fn serve_h2_stream(
	request: http::Request<h2::RecvStream>,
	mut respond: h2::server::SendResponse<Bytes>,
	router: Arc<Mutex<RouterState>>,
	running: Arc<AtomicBool>,
	script: Option<ResponseScript>,
	post: mpsc::Sender<PostAction>,
) {
	let (parts, mut body) = request.into_parts();
	let method = parts.method.to_string();
	let path = parts
		.uri
		.path_and_query()
		.map_or_else(|| parts.uri.path().to_string(), ToString::to_string);
	let headers = parts
		.headers
		.iter()
		.map(|(name, value)| {
			(name.as_str().to_string(), String::from_utf8_lossy(value.as_bytes()).to_string())
		})
		.collect();

	let mut accumulated = BytesMut::new();
	while let Some(chunk) = body.data().await {
		let Ok(data) = chunk else { break };
		let len = data.len();
		accumulated.extend_from_slice(&data);
		let _ = body.flow_control().release_capacity(len);
	}

	// Recorded before any fault runs. A fault that answers nothing is still a
	// request the client made, and what a fault test usually asserts is that the
	// client came back — which is a count of requests, not of answers.
	router_guard(&router).recorded.push(HttpRequest {
		method,
		path,
		version: "HTTP/2.0".to_string(),
		headers,
		body: accumulated.freeze(),
	});

	let script = script.unwrap_or_else(ResponseScript::ok);
	if script.chunks.is_empty() {
		let _ = send_h2_response(&mut respond, script.status, &script.headers, true);
		return;
	}

	let Ok(mut send_stream) = send_h2_response(&mut respond, script.status, &script.headers, false)
	else {
		return;
	};

	let total = script.chunks.len();
	for (index, chunk) in script.chunks.into_iter().enumerate() {
		let is_last = index + 1 == total;
		match chunk {
			WireChunk::Bytes(bytes) => {
				send_stream.reserve_capacity(bytes.len());
				if send_stream.send_data(bytes, is_last).is_err() {
					return;
				}
			},
			WireChunk::Delay(duration) => sleep(duration).await,
			// The stream stays open and silent: the client's own deadline is what
			// ends it.
			WireChunk::IdleStall => {
				stall(&running).await;
				return;
			},
			WireChunk::HardClose => {
				sleep(FLUSH_SETTLE).await;
				let _ = post.send(PostAction::DropSocket).await;
				// Returning here would drop the send half, and h2 answers that
				// with `RST_STREAM(CANCEL)` and PURGES the frames still queued
				// for the stream — so the client saw a cancelled stream instead
				// of the bytes it was written and then a dead socket, which is
				// the whole point of the fault. Holding the stream until the
				// engine stops leaves the socket loss as the only thing the
				// client observes.
				stall(&running).await;
				return;
			},
			WireChunk::H2ResetStream(reason) => {
				send_stream.send_reset(reason);
				return;
			},
			WireChunk::H2GoAway(reason) => {
				sleep(FLUSH_SETTLE).await;
				let _ = post.send(PostAction::Goaway(reason)).await;
				return;
			},
		}
	}
}
