//! Monotonic virtual instant representation.
//!
//! Monotonic virtual time is represented in nanoseconds as [`VirtualInstant`].
//! It enforces saturating arithmetic so that time never goes backwards and
//! never wraps into the past.

use std::{
	fmt,
	ops::{Add, AddAssign, Sub, SubAssign},
	time::Duration,
};

use serde::{Deserialize, Serialize};

/// A monotonic instant in virtual nanoseconds.
///
/// Arithmetic on [`VirtualInstant`] saturates at zero and `u64::MAX`. Virtual
/// time is strictly non-negative and monotonic: subtracting a duration larger
/// than the instant saturates at zero ([`VirtualInstant::ZERO`]) rather than
/// underflowing or wrapping.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
pub struct VirtualInstant(pub u64);

impl VirtualInstant {
	/// The maximum representable virtual instant.
	pub const MAX: Self = Self(u64::MAX);
	/// The beginning of virtual time (0 nanoseconds).
	pub const ZERO: Self = Self(0);

	/// Creates a virtual instant from nanoseconds.
	#[must_use]
	pub const fn from_nanos(nanos: u64) -> Self {
		Self(nanos)
	}

	/// Creates a virtual instant from milliseconds.
	#[must_use]
	pub const fn from_millis(millis: u64) -> Self {
		Self(millis.saturating_mul(1_000_000))
	}

	/// Creates a virtual instant from seconds.
	#[must_use]
	pub const fn from_secs(secs: u64) -> Self {
		Self(secs.saturating_mul(1_000_000_000))
	}

	/// The instant represented as nanoseconds since virtual zero.
	#[must_use]
	pub const fn as_nanos(self) -> u64 {
		self.0
	}

	/// The instant represented as whole milliseconds.
	#[must_use]
	pub const fn as_millis(self) -> u64 {
		self.0 / 1_000_000
	}

	/// The instant represented as whole seconds.
	#[must_use]
	pub const fn as_secs(self) -> u64 {
		self.0 / 1_000_000_000
	}

	/// Adds a [`Duration`], saturating at [`VirtualInstant::MAX`] on overflow.
	#[must_use]
	pub fn saturating_add(self, duration: Duration) -> Self {
		let nanos = u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX);
		Self(self.0.saturating_add(nanos))
	}

	/// Subtracts a [`Duration`], saturating at [`VirtualInstant::ZERO`] on
	/// underflow.
	#[must_use]
	pub fn saturating_sub(self, duration: Duration) -> Self {
		let nanos = u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX);
		Self(self.0.saturating_sub(nanos))
	}

	/// Returns the duration elapsed between `earlier` and `self`, or zero if
	/// `earlier > self`.
	#[must_use]
	pub const fn saturating_duration_since(self, earlier: Self) -> Duration {
		if self.0 >= earlier.0 {
			Duration::from_nanos(self.0 - earlier.0)
		} else {
			Duration::ZERO
		}
	}

	/// Returns the duration elapsed between `earlier` and `self`, or `None` if
	/// `earlier > self`.
	#[must_use]
	pub const fn checked_duration_since(self, earlier: Self) -> Option<Duration> {
		if self.0 >= earlier.0 {
			Some(Duration::from_nanos(self.0 - earlier.0))
		} else {
			None
		}
	}

	/// Returns the duration elapsed between `earlier` and `self`.
	///
	/// # Panics
	/// Panics if `earlier > self`. Use [`saturating_duration_since`] or
	/// [`checked_duration_since`] for non-panicking alternatives.
	#[must_use]
	pub const fn duration_since(self, earlier: Self) -> Duration {
		match self.checked_duration_since(earlier) {
			Some(d) => d,
			None => panic!("earlier instant is in the future"),
		}
	}
}

impl fmt::Display for VirtualInstant {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}ns", self.0)
	}
}

impl Add<Duration> for VirtualInstant {
	type Output = Self;

	fn add(self, rhs: Duration) -> Self::Output {
		self.saturating_add(rhs)
	}
}

impl AddAssign<Duration> for VirtualInstant {
	fn add_assign(&mut self, rhs: Duration) {
		*self = self.saturating_add(rhs);
	}
}

impl Sub<Duration> for VirtualInstant {
	type Output = Self;

	fn sub(self, rhs: Duration) -> Self::Output {
		self.saturating_sub(rhs)
	}
}

impl SubAssign<Duration> for VirtualInstant {
	fn sub_assign(&mut self, rhs: Duration) {
		*self = self.saturating_sub(rhs);
	}
}

impl Sub<Self> for VirtualInstant {
	type Output = Duration;

	fn sub(self, rhs: Self) -> Self::Output {
		self.saturating_duration_since(rhs)
	}
}
