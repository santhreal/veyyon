//! Virtual monotonic time and deterministic scheduler (`vclock`).
//!
//! This module provides deterministic virtual time and discrete-event
//! scheduling for `direct-rust` conformance cases, alongside real-time bounded
//! deadline tracking for `compiled-product` conformance cases.
//!
//! # Subsystem Architecture
//!
//! Conformance cases specify their time delivery via
//! [`crate::corpus::ClockMode`]:
//! - [`crate::corpus::ClockMode::Virtual`]: Direct-Rust cases execute under
//!   [`VirtualClock`] and [`DeterministicScheduler`]. Time is stepped
//!   monotonically in discrete increments, with total ordering over event
//!   deadlines and FIFO tie-breaking for same-instant events.
//! - [`crate::corpus::ClockMode::RealBounded`]: Compiled-product cases execute
//!   against real system time bounded by [`RealBoundedDeadline`]. The API
//!   enforces upper-bound completion checks while intentionally disallowing
//!   fragile exact-duration assertions.

pub mod clock;
pub mod instant;
pub mod real_bounded;
pub mod scheduler;

#[cfg(test)]
mod tests;

pub use clock::{FiredTimer, StepOverrunError, TimerId, VirtualClock};
pub use instant::VirtualInstant;
pub use real_bounded::{DeadlineExceededError, RealBoundedDeadline};
pub use scheduler::{DeterministicScheduler, EventId, ExecutedEvent};
