//! What a channel is, and how one is addressed.

use std::hash::{DefaultHasher, Hash, Hasher};

/// Which value a channel is. The address, with [`Key`], of every number that
/// moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Channel {
	/// The sidebar's width.
	SidebarWidth,
	/// The palette sheet's arrival, and its departure.
	Sheet,
	/// The notice line under the composer.
	Notice,
	/// One session row's hover wash.
	Row,
	/// One session row's first appearance.
	RowEnter,
	/// One project group's disclosure.
	Group,
	/// One button or chip's hover wash.
	Control,
	/// One message's first appearance.
	Message,
	/// One indeterminate indicator's turn. The one channel that repeats.
	Spin,
}

/// A channel's address: what kind of value, and which one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
	pub channel: Channel,
	pub id:      u64,
}

impl Key {
	/// The single channel of its kind.
	pub const fn of(channel: Channel) -> Key {
		Key { channel, id: 0 }
	}

	/// One of many, addressed by a number.
	pub const fn at(channel: Channel, id: u64) -> Key {
		Key { channel, id }
	}

	/// One of many, addressed by a name.
	///
	/// The name is hashed rather than stored, so a row's key costs no
	/// allocation and no string comparison. A collision would blend two rows'
	/// hover washes, which is why this is a 64-bit hash and not a truncation.
	pub fn named(channel: Channel, name: &str) -> Key {
		let mut hasher = DefaultHasher::new();
		name.hash(&mut hasher);
		Key { channel, id: hasher.finish() }
	}
}
