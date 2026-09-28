//! Overlays and navigation primitives: popovers, menus, selects, context
//! menus, tabs, scroll areas, split handles and toasts.
//!
//! Every transition runs through `gpui::motion` with the models in
//! [`crate::theme::motion`]. Under reduced motion (`App::reduce_motion`) a
//! value lands on its target on the frame that changes it.

mod context_menu;
mod menu;
mod popover;
mod scroll_area;
mod select;
mod split_handle;
mod tabs;
mod toasts;

pub use context_menu::ContextMenu;
pub use menu::{LeadingSlot, Menu, MenuEvent, MenuItem, MenuRow};
pub use popover::{Popover, PopoverEvent, Presentation};
pub use scroll_area::ScrollArea;
pub use select::{Select, SelectEvent};
pub use split_handle::SplitHandle;
pub use tabs::{Tab, Tabs, TabsEvent};
pub use toasts::{Toast, ToastId, ToastKind, Toasts};
use veyyon_gpui::{
	App,
	motion::{Animator, FrameInstant, MotionModel},
};

/// Moves `value` toward `target` under `model`, starting from the value and
/// velocity sampled at the current frame instant. Under reduced motion the
/// value lands on `target` at once.
fn drive(value: &mut Animator<FrameInstant>, target: f32, model: MotionModel, cx: &App) {
	let policy = cx.motion_policy();
	if policy.reduced() {
		value.snap(target);
	} else {
		value.retarget(target, model, policy, cx.frame_instant());
	}
}
