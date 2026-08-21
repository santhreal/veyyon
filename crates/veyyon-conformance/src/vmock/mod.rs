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
//! # Out-of-Scope: HTTP/2
//!
//! HTTP/2 transport framing is deliberately **out of scope** for this lane.
//! Implementing HTTP/2 requires HPACK compression tables and complex
//! multiplexed stream framing, which is normally provided by the `h2` crate.
//! Adding external dependencies to `Cargo.toml` is reserved for the main
//! thread, and hand-rolling an ad-hoc HPACK implementation in this crate is not
//! defensible. As such, HTTP/2 is unwritten and named here as an explicit
//! exclusion.
//!
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
//! - [`http`]: Hand-written HTTP/1.1 request parser and response writer.
//! - [`script`]: Scripted byte-exact wire delivery programmes.

pub mod engine;
pub mod fault;
pub mod guard;
pub mod http;
pub mod script;

#[cfg(test)]
mod tests;

pub use engine::Engine;
pub use fault::FaultKind;
pub use guard::{DenyViolation, NetworkDenyGuard};
pub use http::{HttpParseError, HttpRequest};
pub use script::{ResponseScript, WireChunk};
