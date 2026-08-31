//! Stable retained identities for bottom-dock controls.

use gpui::SharedString;
use veyyon_gui_kit::{
	motion::{OwnerNamespace, RetainedKey, owner},
	ui::{Button, Icon, Row},
};

fn key(id: &str) -> RetainedKey {
	owner(OwnerNamespace::Terminal, "control", id)
}
pub fn retained(id: &str) -> RetainedKey {
	key(id)
}

pub fn button(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Button {
	let id = id.into();
	Button::labelled(id.clone(), key(id.as_ref()), label)
}

pub fn icon_button(id: impl Into<SharedString>, icon: Icon) -> Button {
	let id = id.into();
	Button::new(id.clone(), key(id.as_ref()), icon)
}

pub fn enabled(button: Button, condition: bool, reason: impl Into<SharedString>) -> Button {
	if condition {
		button
	} else {
		button.disabled(reason)
	}
}

pub fn row(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Row {
	let id = id.into();
	Row::new(id.clone(), key(id.as_ref()), title)
}
