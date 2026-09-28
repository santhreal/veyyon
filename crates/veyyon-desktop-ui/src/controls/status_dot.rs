//! A small filled circle that shows the state of a thread or a task.

use veyyon_gpui::{App, Hsla, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::theme::{ActiveTheme, Palette, size};

/// The state a [`StatusDot`] shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DotStatus {
	/// A turn is in progress: `status.running`.
	Running,
	/// Input is awaited: `status.waiting`.
	Waiting,
	/// The last turn failed: `status.error`.
	Error,
	/// The last turn succeeded: `status.success`.
	Success,
	/// Output arrived that has not been read: `status.info`.
	Unread,
	/// Nothing is happening: `text.faint`.
	Idle,
}

impl DotStatus {
	/// The palette color of the state.
	pub const fn color(self, palette: &Palette) -> Hsla {
		match self {
			Self::Running => palette.status.running,
			Self::Waiting => palette.status.waiting,
			Self::Error => palette.status.error,
			Self::Success => palette.status.success,
			Self::Unread => palette.status.info,
			Self::Idle => palette.text.faint,
		}
	}
}

/// A [`size::DOT`] circle in the color of a [`DotStatus`].
#[derive(Clone, Copy, Debug, IntoElement)]
pub struct StatusDot {
	status: DotStatus,
}

impl StatusDot {
	/// A dot showing `status`.
	pub const fn new(status: DotStatus) -> Self {
		Self { status }
	}
}

impl RenderOnce for StatusDot {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		div()
			.flex_none()
			.size(size::DOT)
			.rounded_full()
			.bg(self.status.color(&cx.theme().palette))
	}
}
