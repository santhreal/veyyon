//! Bounded event-time collection reconciliation.
//!
//! A caller provides stable retained ids and old/new row positions after its
//! model diff. This module fills a fixed twelve-slot plan. Rendering only reads
//! the resulting transforms from [`Motion`](super::Motion).

use super::{MAX_COLLECTION_GHOSTS, RetainedKey, spec::stagger_delay};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CollectionItem {
	pub owner:    RetainedKey,
	pub position: f32,
	pub selected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CollectionChange {
	Insert { owner: RetainedKey, delay_ms: u16 },
	Remove { owner: RetainedKey, delay_ms: u16 },
	Move { owner: RetainedKey, from: f32, to: f32, delay_ms: u16 },
}

#[derive(Debug, Clone, Copy)]
pub struct CollectionPlan {
	changes: [Option<CollectionChange>; MAX_COLLECTION_GHOSTS],
	len:     usize,
}

impl Default for CollectionPlan {
	fn default() -> Self {
		Self { changes: [None; MAX_COLLECTION_GHOSTS], len: 0 }
	}
}

impl CollectionPlan {
	pub fn reconcile(old: &[CollectionItem], new: &[CollectionItem]) -> Self {
		let mut plan = Self::default();
		// Selected items go first so capacity pressure never drops their motion.
		for selected_only in [true, false] {
			for item in new {
				if item.selected != selected_only || plan.contains(item.owner) {
					continue;
				}
				let change = match old.iter().find(|old| old.owner == item.owner) {
					Some(previous) if (previous.position - item.position).abs() > f32::EPSILON => {
						Some(CollectionChange::Move {
							owner:    item.owner,
							from:     previous.position,
							to:       item.position,
							delay_ms: stagger_delay(plan.len),
						})
					},
					None => Some(CollectionChange::Insert {
						owner:    item.owner,
						delay_ms: stagger_delay(plan.len),
					}),
					_ => None,
				};
				if let Some(change) = change {
					plan.push(change);
				}
			}
		}
		for item in old {
			if plan.len == MAX_COLLECTION_GHOSTS {
				break;
			}
			if !new.iter().any(|new| new.owner == item.owner) {
				plan.push(CollectionChange::Remove {
					owner:    item.owner,
					delay_ms: stagger_delay(plan.len),
				});
			}
		}
		plan
	}

	fn push(&mut self, change: CollectionChange) {
		if self.len < MAX_COLLECTION_GHOSTS {
			self.changes[self.len] = Some(change);
			self.len += 1;
		}
	}

	fn contains(&self, owner: RetainedKey) -> bool {
		self.changes[..self.len]
			.iter()
			.flatten()
			.any(|change| match change {
				CollectionChange::Insert { owner: key, .. }
				| CollectionChange::Remove { owner: key, .. }
				| CollectionChange::Move { owner: key, .. } => *key == owner,
			})
	}

	pub fn iter(&self) -> impl Iterator<Item = CollectionChange> + '_ {
		self.changes[..self.len].iter().flatten().copied()
	}

	pub const fn len(&self) -> usize {
		self.len
	}

	pub const fn is_empty(&self) -> bool {
		self.len == 0
	}
}
