//! Stable retained identities for settings-owned controls.

use std::{
	collections::BTreeMap,
	sync::{LazyLock, Mutex},
};

use gpui::SharedString;
use veyyon_gui_kit::{
	motion::{OwnerNamespace, RetainedKey},
	ui::{Button, Icon, Row, Select, Spinner, Stepper, Switch, Tab},
};

static REGISTRY: LazyLock<Mutex<SettingsKeyRegistry>> =
	LazyLock::new(|| Mutex::new(SettingsKeyRegistry::new()));
struct SettingsKeyRegistry {
	owners: BTreeMap<String, RetainedKey>,
	next:   u64,
}

impl SettingsKeyRegistry {
	fn new() -> Self {
		Self { owners: BTreeMap::new(), next: 1 }
	}

	fn get_or_create(&mut self, value: &str) -> RetainedKey {
		if let Some(key) = self.owners.get(value) {
			return *key;
		}
		let local = self.next;
		self.next = self.next.saturating_add(1);
		let key = RetainedKey::scoped(OwnerNamespace::Settings, local, 0).unwrap_or_else(|| {
			RetainedKey::semantic(OwnerNamespace::Settings, (local & 0x00ff_ffff) as u32)
		});
		self.owners.insert(value.to_owned(), key);
		key
	}
}

pub fn key(value: &str) -> RetainedKey {
	if let Ok(mut guard) = REGISTRY.lock() {
		guard.get_or_create(value)
	} else {
		RetainedKey::semantic(OwnerNamespace::Settings, 1)
	}
}

pub fn button(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Button {
	let id = id.into();
	let owner = key(id.as_ref());
	Button::labelled(id, owner, label)
}

pub fn icon_button(id: impl Into<SharedString>, icon: Icon) -> Button {
	let id = id.into();
	let owner = key(id.as_ref());
	Button::new(id, owner, icon)
}

pub fn row(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Row {
	let id = id.into();
	let owner = key(id.as_ref());
	Row::new(id, owner, title)
}

pub fn spinner(id: impl Into<SharedString>, icon: Icon) -> Spinner {
	let id = id.into();
	let owner = key(id.as_ref());
	Spinner::new(owner, icon)
}

pub fn switch(id: impl Into<SharedString>, on: bool) -> Switch {
	let id = id.into();
	let owner = key(id.as_ref());
	Switch::new(id, owner, on)
}

pub fn tab(label: impl Into<SharedString>, selected: bool) -> Tab {
	let label = label.into();
	let owner = key(label.as_ref());
	Tab::new(owner, label, selected)
}

pub fn stepper(id: impl Into<SharedString>, value: impl Into<SharedString>) -> Stepper {
	let id = id.into();
	let down_owner = key(&format!("{}-down", id));
	let up_owner = key(&format!("{}-up", id));
	Stepper::new(id, down_owner, up_owner, value)
}

pub fn select(id: impl Into<SharedString>, value: impl Into<SharedString>) -> Select {
	let id = id.into();
	let owner = key(id.as_ref());
	Select::new(id, owner, value)
}
