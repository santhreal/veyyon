//! The control primitives every view is built from. Each is a `RenderOnce`
//! builder that reads its colors from the active theme and its measures from
//! the theme scales.

mod button;
mod divider;
mod icon_button;
mod kbd;
mod list_row;
mod spinner;
mod status_dot;
mod toggle;
mod tooltip;

use std::time::Duration;

pub use button::{Button, ButtonSize, ButtonVariant};
pub use divider::{Divider, DividerAxis};
pub use icon_button::IconButton;
pub use kbd::{Kbd, KeyPlatform};
pub use list_row::ListRow;
pub use spinner::Spinner;
pub use status_dot::{DotStatus, StatusDot};
pub use toggle::Toggle;
pub use tooltip::Tooltip;
use veyyon_gpui::{StyleTransition, motion::MotionModel};

use crate::theme::motion;

/// The style transition a hovered or pressed element changes color with:
/// [`motion::HOVER`] expressed as a GPUI style transition. A model other than
/// a timed one changes color at once.
#[must_use]
pub fn hover_transition() -> StyleTransition {
	let duration_ms = match motion::HOVER {
		MotionModel::Duration(timed) => timed.duration_ms,
		_ => 0,
	};
	StyleTransition::duration(Duration::from_millis(u64::from(duration_ms)))
}
