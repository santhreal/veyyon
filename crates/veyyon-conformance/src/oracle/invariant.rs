//! Algebraic invariants: judging two observations against each other.
//!
//! A committed expectation says what the right answer is. An invariant says
//! what has to be true of any answer, which is what lets a case judge a codec,
//! a formatter or a patch engine without a reference implementation of it. The
//! corpus reaches these through contracts whose oracle constrains no value and
//! whose stimulus runs the same operation twice in two arrangements.
//!
//! This module compares bytes and reports where they diverge. It deliberately
//! implements none of the operations it judges: an invariant that reimplements
//! the production algorithm is a second copy of the bug, and the whole point of
//! `decode(encode(x)) == x` is that it holds without anybody writing down what
//! `encode` should produce.

use std::fmt;

/// Which property a pair of observations is being held to.
///
/// The names are the ones the design document uses, and each variant says which
/// two things the pair actually is, because that is the part a reader gets
/// wrong: for invertibility the left side is the ORIGINAL input, not a first
/// pass over it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Invariant {
	/// `decode(encode(x)) == x`. Left is `x`, right is the round trip.
	Invertibility,
	/// `f(f(x)) == f(x)`. Left is one application, right is two.
	Idempotence,
	/// `apply(apply(s, a), b) == apply(apply(s, b), a)` for disjoint operations.
	/// Left is one order, right is the other.
	Commutativity,
}

impl Invariant {
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Invertibility => "invertibility",
			Self::Idempotence => "idempotence",
			Self::Commutativity => "commutativity",
		}
	}

	/// Every invariant this module can judge.
	///
	/// A sweep enumerates from here rather than from a list of its own, so
	/// adding a variant turns a suite that claims to cover all of them red.
	#[must_use]
	pub const fn all() -> [Self; 3] {
		[Self::Invertibility, Self::Idempotence, Self::Commutativity]
	}
}

impl fmt::Display for Invariant {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

/// A broken invariant.
///
/// It reports lengths and the first differing offset, never the bytes. A shard
/// report is committed and read by anyone; a fixture body in it is a fixture
/// published, and a 64 KB payload in it is a report nobody opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Breach {
	pub invariant:        Invariant,
	pub left_len:         usize,
	pub right_len:        usize,
	/// The first offset at which the two sides differ, or `None` when one side
	/// is a prefix of the other and the difference is only length.
	pub first_difference: Option<usize>,
}

impl fmt::Display for Breach {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self.first_difference {
			Some(offset) => write!(
				f,
				"{} broken: {} and {} bytes diverge at offset {offset}",
				self.invariant, self.left_len, self.right_len
			),
			None => write!(
				f,
				"{} broken: {} bytes is a prefix of {} bytes",
				self.invariant, self.left_len, self.right_len
			),
		}
	}
}

/// Hold two observations to an invariant. `None` means it held.
#[must_use]
pub fn check(invariant: Invariant, left: &[u8], right: &[u8]) -> Option<Breach> {
	if left == right {
		return None;
	}
	Some(Breach {
		invariant,
		left_len: left.len(),
		right_len: right.len(),
		first_difference: left.iter().zip(right).position(|(a, b)| a != b),
	})
}
