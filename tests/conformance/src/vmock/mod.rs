//! Virtual Mock Provider Engine (`vmock`).
//!
//! An embedded loopback HTTP/1.1 provider server that binds to ephemeral TCP
//! ports on `127.0.0.1` and provides byte-exact control over wire delivery,
//! chunk sizes (1 byte to 1024 bytes per write), and transport faults.
//!
//! # Architecture & Purpose
//!
//! Provider conformance begins at raw HTTP transport bytes and ends after
//! stream decoding, event accumulation, and session persistence. Replacing a
//! provider client module with pre-parsed events bypasses framing, decoding,
//! utf-8 reassembly, and transport error handling. `vmock` acts as the real
//! loopback server so the actual production provider client can be pointed at
//! its `baseUrl` and tested over a real TCP socket.
//!
//! # HTTP/2 (h2c) Support
//!
//! `vmock` natively supports HTTP/2 with prior knowledge (h2c) on the same
//! port as HTTP/1.1 via transparent connection sniffing. If an incoming TCP
//! stream begins with the 24-octet HTTP/2 client connection preface
//! (`PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`), it is handled by the [`h2c`] submodule
//! using the `h2` crate. Otherwise, it is parsed by the HTTP/1.1 parser.
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
//! # Observability Scope of Network-Deny Guard
//!
//! The [`NetworkDenyGuard`] asserts that test cases and provider configurations
//! only connect to the designated ephemeral loopback port allocated to the
//! running [`Engine`].
//!
//! **Boundary Note:** The network-deny guard inspects and validates
//! destinations, URLs, and socket addresses routed through or registered with
//! the conformance harness. It *cannot* observe arbitrary out-of-band raw OS
//! socket syscalls that an external process might invoke without going through
//! configured harness endpoints.
//!
//! # Submodules
//!
//! - [`engine`]: Server lifecycle, accept loop, and route dispatching.
//! - [`fault`]: Predefined provider fault taxonomy and payloads.
//! - [`guard`]: Loopback-only network-deny assertion guard.
//! - [`h2c`]: HTTP/2 cleartext (h2c) transport and fault engine.
//! - [`http`]: Hand-written HTTP/1.1 request parser and response writer.
//! - [`script`]: Scripted byte-exact wire delivery programmes.

pub mod engine;
pub mod fault;
pub mod guard;
pub mod h2c;
pub mod http;
pub mod script;
#[cfg(test)]
mod tests;

pub use engine::Engine;
pub use fault::{
	FaultKind, H2ConnectionFault, H2FaultInstall, H2FaultKind, H2Reason, MID_DATA_CHUNK,
};
pub use guard::{DenyViolation, NetworkDenyGuard};
pub use http::{HttpParseError, HttpRequest};
pub use script::{ResponseScript, WireChunk};
