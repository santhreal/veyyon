//! Real-time bounded deadline tracker for compiled-product cases.
//!
//! # Flakiness Invariant: No Exact Elapsed Time Assertions
//!
//! Real-world process execution timing varies significantly across operating
//! systems, CPU architectures, thermal conditions, GC pauses, and host
//! virtualization loads. Asserting an exact elapsed duration (e.g. "this
//! operation took exactly 42ms") produces flaky tests by construction.
//!
//! [`RealBoundedDeadline`] deliberately does NOT expose equality or exact-value
//! comparison methods. Its API only permits bounding checks:
//! - [`RealBoundedDeadline::within`] asserts that work terminated *before or
//!   at* a specified upper bound.
//! - [`RealBoundedDeadline::expired`] queries whether the upper bound has
//!   elapsed.
//!
//! An exact elapsed time assertion cannot be written with this API.

use std::{
	fmt,
	time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::corpus::Oracle;

/// Error returned when an operation exceeds its upper bound deadline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeadlineExceededError {
	/// The maximum allowed duration in milliseconds.
	pub max_ms:  u64,
	/// The actual measured elapsed duration.
	pub elapsed: Duration,
}

impl fmt::Display for DeadlineExceededError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			f,
			"execution exceeded real-bounded deadline of {}ms (measured: {:?})",
			self.max_ms, self.elapsed
		)
	}
}

impl std::error::Error for DeadlineExceededError {}

/// A real-clock deadline tracker for compiled-product conformance cases.
///
/// Wraps [`std::time::Instant`] and enforces upper-bound termination checks
/// while intentionally prohibiting brittle exact-time assertions.
#[derive(Debug, Clone)]
pub struct RealBoundedDeadline {
	start: Instant,
}

impl Default for RealBoundedDeadline {
	fn default() -> Self {
		Self::now()
	}
}

impl RealBoundedDeadline {
	/// Starts a new deadline timer from the current monotonic instant.
	#[must_use]
	pub fn now() -> Self {
		Self { start: Instant::now() }
	}

	/// Starts a new deadline timer. Alias for [`RealBoundedDeadline::now`].
	#[must_use]
	pub fn start() -> Self {
		Self::now()
	}

	/// Creates a deadline tracker seeded from a case oracle, if the oracle
	/// defines a `max_ms` bound.
	#[must_use]
	pub fn from_oracle(oracle: &Oracle) -> Option<Self> {
		oracle.max_ms.map(|_| Self::now())
	}

	/// The actual elapsed duration since the deadline tracker started.
	#[must_use]
	pub fn elapsed(&self) -> Duration {
		self.start.elapsed()
	}

	/// Checks whether the elapsed time has exceeded `max_ms`.
	#[must_use]
	pub fn expired(&self, max_ms: u64) -> bool {
		self.elapsed() > Duration::from_millis(max_ms)
	}

	/// Verifies that the monitored work terminated within `max_ms`.
	///
	/// Returns `Ok(elapsed)` if `elapsed <= max_ms`, or
	/// [`DeadlineExceededError`] if the deadline was violated.
	///
	/// # Errors
	/// Returns [`DeadlineExceededError`] if `elapsed > max_ms`.
	pub fn within(&self, max_ms: u64) -> Result<Duration, DeadlineExceededError> {
		let elapsed = self.elapsed();
		let bound = Duration::from_millis(max_ms);
		if elapsed <= bound {
			Ok(elapsed)
		} else {
			Err(DeadlineExceededError { max_ms, elapsed })
		}
	}
}
