//! The pieces every surface is built from.
//!
//! One file per primitive. A primitive is a value with builder methods and a
//! [`RenderOnce`](gpui::RenderOnce) implementation, so a surface declares what
//! it wants and hands over what a press does:
//!
//! ```ignore
//! Button::new("send", Icon::Send).tone(Tone::Accent).tip("Send").on_click(cx.listener(..))
//! ```
//!
//! A primitive reads no store, no session and no command. It takes what it
//! draws, and the palette, the frame's instant and the motion registry come
//! from [`paint`](crate::paint), which is why a control fades its own hover
//! without the surface it sits in knowing that it does.
//!
//! What follows: a surface can be split, moved between crates or replaced
//! without touching anything it draws with, and every control of one kind in
//! the window is the same control.

pub mod activity;
pub mod badge;
pub mod banner;
pub mod button;
pub mod card;
pub mod checkbox;
pub mod composer;
pub mod disclosure;
pub mod edge_fade;
pub mod empty;
pub mod field;
pub mod focus;
pub mod icon;
pub mod image;
pub mod kbd;
pub mod key_cap;
pub mod menu;
pub mod meter;
pub mod overlay;
pub mod picker;
pub mod popover;
pub mod progress;
pub mod radio;
pub mod row;
pub mod scrollbar;
pub mod search;
pub mod segmented;
pub mod select;
pub mod sheet;
pub mod spinner;
pub mod split_handle;
pub mod state;
pub mod status;
pub mod stepper;
pub mod surface;
pub mod switch;
pub mod tabs;
pub mod text;
pub mod toast;
pub mod toolbar;
pub mod tooltip;
pub mod tree_row;

pub mod viewport;

pub use activity::ActivityItem;
pub use badge::Badge;
pub use banner::Banner;
pub use button::Button;
pub use card::Card;
pub use checkbox::{Check, Checkbox};
pub use composer::ComposerChrome;
pub use edge_fade::{EdgeFade, FadedEdges, Scrolls, edge_fade, scrolls_list, scrolls_uniform};
pub use empty::Empty;
pub use field::{Field, Group};
pub use focus::FocusScope;
use gpui::{Div, Hsla, div, prelude::*, px};
pub use icon::Icon;
pub use image::ImagePreview;
pub use key_cap::KeyCap;
pub use menu::{Menu, MenuItem};
pub use meter::Meter;
pub use overlay::{Dialog, Popover};
pub use picker::{
	Picker, PickerAction, PickerGroup, PickerItem, PickerPreview, picker_owner, picker_preview,
	picker_row, picker_scroll, picker_search,
};
pub use popover::{Alignment, AnchoredPopover, DismissalRoute, PopoverBounds, PopoverState, Side};
pub use progress::{Progress, Skeleton};
pub use radio::Radio;
pub use row::Row;
pub use scrollbar::Scrollbar;
pub use search::{SearchField, SearchGround};
pub use segmented::SegmentedControl;
pub use select::Select;
pub use sheet::Sheet;
pub use spinner::Spinner;
pub use split_handle::{SplitAxis, SplitHandle};
pub use state::{StateKind, StateSurface};
pub use status::StatusDot;
pub use stepper::Stepper;
pub use surface::{Panel, Well};
pub use switch::Switch;
pub use tabs::{Tab, Tabs};
pub use text::{hairline, line, line_of, meta, spacer, stack};
pub use toast::{Toast, ToastSlot};
pub use toolbar::Toolbar;
pub use tooltip::Tip;
pub use tree_row::TreeRow;
pub use viewport::VirtualListMetrics;

use crate::theme::{Theme, layout, size, space};

/// What a control means, and therefore what colour it is.
///
/// A tone is a meaning, not a colour: `Ok` is something that finished, `Warn`
/// is something waiting on an answer. The palette decides what those look like,
/// so a surface never picks a colour to say a state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Tone {
	/// The default: text colour, no fill.
	#[default]
	Plain,
	/// Present but secondary: a caption, a count, a control that is off.
	Muted,
	/// The one thing on screen to press.
	Accent,
	/// Something finished and did what it said.
	Ok,
	/// Something is waiting on an answer.
	Warn,
	/// Something failed, or cannot be undone.
	Danger,
}

impl Tone {
	/// The ink text and glyphs take in this tone.
	pub fn ink(self, theme: &Theme) -> Hsla {
		match self {
			Tone::Plain => theme.text,
			Tone::Muted => theme.text_muted,
			Tone::Accent => theme.accent,
			Tone::Ok => theme.ok,
			Tone::Warn => theme.warn,
			Tone::Danger => theme.danger,
		}
	}

	/// The fill a solid control takes in this tone, and the ink that reads on
	/// it.
	pub fn solid(self, theme: &Theme) -> (Hsla, Hsla) {
		match self {
			Tone::Plain => (theme.raised, theme.text),
			Tone::Muted => (theme.sunken, theme.text_muted),
			Tone::Accent => (theme.accent, theme.text_on_accent),
			Tone::Ok => (theme.ok, theme.text_on_accent),
			Tone::Warn => (theme.warn, theme.text_on_accent),
			Tone::Danger => (theme.danger, theme.text_on_accent),
		}
	}

	/// The fill a tinted control takes: the tone at the weight that can carry
	/// text of the same tone.
	pub fn tint(self, theme: &Theme) -> Hsla {
		theme.tint(self.ink(theme))
	}
}

/// How much ground a control covers.
///
/// Three fills, and the choice says how much of the window's attention the
/// control is asking for. One solid control per surface at most.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Fill {
	/// No fill until the pointer is over it. Everything in a header, and every
	/// control that sits next to text.
	#[default]
	Ghost,
	/// The tone at tint weight. A state, a chip, a control that is on.
	Tinted,
	/// The tone at full weight. The one action a surface exists for.
	Solid,
}

/// How large a control is. Two sizes: one that sits in a line of text, one that
/// stands on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Size {
	/// Inside a line of text: a badge, a row's trailing control.
	Small,
	/// On its own: a header's button, the composer's send.
	#[default]
	Base,
}

impl Size {
	/// The height a control of this size takes.
	pub fn height(self) -> f32 {
		match self {
			Size::Small => layout::control_height(),
			Size::Base => crate::theme::row::roomy(),
		}
	}

	/// The text size inside it.
	pub fn text(self) -> f32 {
		match self {
			Size::Small => size::meta(),
			Size::Base => size::body(),
		}
	}

	/// The icon size inside it.
	pub fn glyph(self) -> f32 {
		match self {
			Size::Small => icon::scale::small(),
			Size::Base => icon::scale::base(),
		}
	}

	/// The horizontal padding a labelled control of this size takes.
	pub fn pad(self) -> f32 {
		match self {
			Size::Small => space::SNUG,
			Size::Base => space::BASE,
		}
	}

	/// The gap between a control's glyph and its label.
	pub fn gap(self) -> f32 {
		match self {
			Size::Small => space::TIGHT,
			Size::Base => space::SNUG,
		}
	}
}

/// A square that takes no part in layout beyond its size. The shape every
/// glyph-only control is built on.
pub fn square(size: f32) -> Div {
	div()
		.flex()
		.flex_none()
		.items_center()
		.justify_center()
		.size(px(size))
}
#[cfg(test)]
mod every_toast_animates_on_its_own_retained_track;
