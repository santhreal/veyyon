//! A domain the host replaces whole, carrying the count of answers it has sent.

use std::fmt::Debug;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A domain value and how many answers have arrived for it.
///
/// A projection that derives something expensive from a domain -- a megabyte
/// of unified diff parsed into rows, a file highlighted line by line -- holds
/// what it built and derives again when the count moves. The count is what
/// makes that possible: the window re-projects on every host event batch, so
/// during a streamed turn the panel is asked for its content dozens of times a
/// second, and comparing the value to decide costs as much as re-deriving it.
///
/// Every write goes through [`Answered::set`] or [`Answered::clear`], so a new
/// write site cannot leave a projection holding what the host replaced.
///
/// Two of these are equal when their values are. The count states when an
/// answer arrived rather than what the domain holds, and it serializes as the
/// value alone, so a store restored from disk and a store that received one
/// answer describe the same domain.
#[derive(Debug, Clone)]
pub struct Answered<T> {
	value:   Option<T>,
	answers: u64,
}

// Derived `Default` would require one of the domain views, none of which has
// an empty value that means anything: nothing answered is the default here.
impl<T> Default for Answered<T> {
	fn default() -> Self {
		Self { value: None, answers: 0 }
	}
}

impl<T> Answered<T> {
	/// The value the last answer carried, if one has arrived.
	pub const fn get(&self) -> Option<&T> {
		self.value.as_ref()
	}

	/// Whether an answer is being held.
	pub const fn is_some(&self) -> bool {
		self.value.is_some()
	}

	/// Replaces the value and counts the answer.
	pub fn set(&mut self, value: T) {
		self.value = Some(value);
		self.answers = self.answers.saturating_add(1);
	}

	/// Drops the value and counts the change, so a projection holding what was
	/// here derives again and draws nothing.
	pub fn clear(&mut self) {
		self.value = None;
		self.answers = self.answers.saturating_add(1);
	}

	/// How many answers have arrived. A projection records this beside what it
	/// derived and compares it before deriving again.
	pub const fn answers(&self) -> u64 {
		self.answers
	}
}

impl<T> From<Option<T>> for Answered<T> {
	fn from(value: Option<T>) -> Self {
		let answers = u64::from(value.is_some());
		Self { value, answers }
	}
}

impl<T: PartialEq> PartialEq for Answered<T> {
	fn eq(&self, other: &Self) -> bool {
		self.value == other.value
	}
}

impl<T: Eq> Eq for Answered<T> {}

impl<T: Serialize> Serialize for Answered<T> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		self.value.serialize(serializer)
	}
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Answered<T> {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		Option::<T>::deserialize(deserializer).map(Self::from)
	}
}
