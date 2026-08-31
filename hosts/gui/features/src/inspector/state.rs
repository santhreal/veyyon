//! Long-lived retained identity registry for inspector outline rows and
//! controls.

use std::{cell::RefCell, collections::BTreeMap};

use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey};

const FIRST_DYNAMIC_OWNER: u64 = 256;

#[derive(Debug)]
pub struct InspectorState {
	owners: BTreeMap<String, RetainedKey>,
	next:   u64,
}

impl Default for InspectorState {
	fn default() -> Self {
		Self { owners: BTreeMap::new(), next: FIRST_DYNAMIC_OWNER }
	}
}

impl InspectorState {
	pub fn owner(&mut self, key: &str) -> RetainedKey {
		if let Some(owner) = self.owners.get(key) {
			return *owner;
		}
		let owner = RetainedKey::scoped(OwnerNamespace::Shell, self.next, 0).unwrap_or_else(|| {
			RetainedKey::semantic(OwnerNamespace::Shell, (self.next & 0x00ff_ffff) as u32)
		});
		self.next = self.next.saturating_add(1);
		self.owners.insert(key.to_owned(), owner);
		owner
	}
}

thread_local! {
	static REGISTRY: RefCell<InspectorState> = RefCell::new(InspectorState::default());
}

pub fn with_state<R>(f: impl FnOnce(&mut InspectorState) -> R) -> R {
	REGISTRY.with(|cell| f(&mut cell.borrow_mut()))
}

pub fn owner(key: &str) -> RetainedKey {
	with_state(|state| state.owner(key))
}
