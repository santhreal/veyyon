//! Stable retained motion identities for the notification stack and toasts.

use veyyon_gui_core::model::NotificationId;
use veyyon_gui_kit::{
	motion::{OwnerNamespace, RetainedKey, control, owner},
	ui::ToastSlot,
};

const NS: OwnerNamespace = OwnerNamespace::Overlays;
const TOAST_KIND: &str = "toast";
const STACK_KIND: &str = "notification-stack";

/// Fixed controls for the notification stack container.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StackChrome {
	DismissAll,
	More,
}

impl StackChrome {
	pub const ALL: [Self; 2] = [Self::DismissAll, Self::More];

	pub const fn name(self) -> &'static str {
		match self {
			Self::DismissAll => "dismiss-all",
			Self::More => "more",
		}
	}
}

/// The retained motion key for a toast root container.
pub fn toast_owner(id: &NotificationId) -> RetainedKey {
	owner(NS, TOAST_KIND, id.as_str())
}

/// The retained motion key for a control inside a toast.
pub fn toast_control(id: &NotificationId, slot: ToastSlot) -> RetainedKey {
	control(NS, TOAST_KIND, id.as_str(), slot.offset())
}

/// The retained motion key for a stack-level control.
pub fn stack_control(chrome: StackChrome) -> RetainedKey {
	owner(NS, STACK_KIND, chrome.name())
}
