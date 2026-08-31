//! Long-lived retained identity registry for inspector outline rows and
//! controls.

use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, owner as motion_owner};

#[derive(Debug, Default)]
pub struct InspectorState;

impl InspectorState {
	pub fn owner(&mut self, key: &str) -> RetainedKey {
		owner(key)
	}
}

pub fn owner(key: &str) -> RetainedKey {
	motion_owner(OwnerNamespace::Shell, "inspector", key)
}
