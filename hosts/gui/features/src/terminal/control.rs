//! Stable retained identities for bottom-dock controls.

use gpui::SharedString;
use veyyon_gui_kit::{
	motion::{OwnerNamespace, RetainedKey},
	ui::{Button, Icon, Row},
};

fn key(id: &str) -> RetainedKey {
	let mut hash = 0xcbf2_9ce4_8422_2325u64;
	for byte in id.as_bytes() {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}
	RetainedKey::new(((OwnerNamespace::Terminal as u64) << 56) | (hash & 0x00ff_ffff_ffff_ffff), 0)
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
