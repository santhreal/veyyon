//! Named values, read down.
//!
//! Most tool results are this: a path and a line count, a command and an exit
//! status, a query and a match count. `parts.tsx` draws it as `KvGrid` of `Kv`,
//! and a single pair as `Row`.

use super::{Badge, Tone};

/// A set of named values.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Fields {
	pub pairs: Vec<Pair>,
}

impl Fields {
	pub fn new(pairs: Vec<Pair>) -> Fields {
		Fields { pairs }
	}

	/// The value under `name`, for a renderer that puts one pair somewhere of
	/// its own rather than in the grid.
	pub fn get(&self, name: &str) -> Option<&str> {
		self
			.pairs
			.iter()
			.find(|pair| pair.name == name)
			.map(|pair| pair.value.as_str())
	}
}

/// One named value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pair {
	pub name:    String,
	pub value:   String,
	/// The verdict on the value, not on the name.
	pub tone:    Option<Tone>,
	pub badges:  Vec<Badge>,
	/// True when the value is a path, which a host shortens against the home
	/// directory and the working directory rather than printing whole.
	pub is_path: bool,
}

impl Pair {
	pub fn new(name: impl Into<String>, value: impl Into<String>) -> Pair {
		Pair {
			name:    name.into(),
			value:   value.into(),
			tone:    None,
			badges:  Vec::new(),
			is_path: false,
		}
	}

	/// A pair whose value is a path.
	pub fn path(name: impl Into<String>, value: impl Into<String>) -> Pair {
		Pair { is_path: true, ..Pair::new(name, value) }
	}

	pub fn tone(mut self, tone: Tone) -> Pair {
		self.tone = Some(tone);
		self
	}

	pub fn badge(mut self, badge: Badge) -> Pair {
		self.badges.push(badge);
		self
	}
}
