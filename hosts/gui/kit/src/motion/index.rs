//! Fixed open-addressed index for continuous motion slots.

use super::MotionKey;

const INDEX_CAPACITY: usize = 64;

#[derive(Debug, Clone, Copy)]
enum Entry {
	Empty,
	Tombstone,
	Occupied { key: MotionKey, slot: u8 },
}

pub(super) struct KeyIndex {
	entries: [Entry; INDEX_CAPACITY],
}

impl KeyIndex {
	pub const fn new() -> Self {
		Self { entries: [Entry::Empty; INDEX_CAPACITY] }
	}

	fn start(key: MotionKey) -> usize {
		let mut value = key.owner.object
			^ (u64::from(key.owner.generation) << 17)
			^ ((key.property as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15));
		value ^= value >> 30;
		value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
		value ^= value >> 27;
		(value as usize) & (INDEX_CAPACITY - 1)
	}

	pub fn find(&self, key: MotionKey) -> Option<usize> {
		let start = Self::start(key);
		for probe in 0..INDEX_CAPACITY {
			match self.entries[(start + probe) & (INDEX_CAPACITY - 1)] {
				Entry::Empty => return None,
				Entry::Occupied { key: found, slot } if found == key => return Some(usize::from(slot)),
				_ => {},
			}
		}
		None
	}

	pub fn insert(&mut self, key: MotionKey, slot: usize) -> bool {
		let start = Self::start(key);
		let mut tombstone = None;
		for probe in 0..INDEX_CAPACITY {
			let index = (start + probe) & (INDEX_CAPACITY - 1);
			match self.entries[index] {
				Entry::Occupied { key: found, .. } if found == key => {
					self.entries[index] = Entry::Occupied { key, slot: slot as u8 };
					return true;
				},
				Entry::Tombstone if tombstone.is_none() => tombstone = Some(index),
				Entry::Empty => {
					let destination = tombstone.unwrap_or(index);
					self.entries[destination] = Entry::Occupied { key, slot: slot as u8 };
					return true;
				},
				_ => {},
			}
		}
		false
	}

	pub fn remove(&mut self, key: MotionKey) {
		let start = Self::start(key);
		for probe in 0..INDEX_CAPACITY {
			let index = (start + probe) & (INDEX_CAPACITY - 1);
			match self.entries[index] {
				Entry::Empty => return,
				Entry::Occupied { key: found, .. } if found == key => {
					self.entries[index] = Entry::Tombstone;
					return;
				},
				_ => {},
			}
		}
	}

	pub fn clear(&mut self) {
		self.entries.fill(Entry::Empty);
	}
}

const _: () = assert!(INDEX_CAPACITY.is_power_of_two());
