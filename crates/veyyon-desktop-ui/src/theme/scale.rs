//! Spacing, corner radii and the type ramp. A view reads every measure from
//! here and never writes a literal pixel value of its own.

use veyyon_gpui::{FontWeight, Pixels, Styled, px};

use crate::fonts::{MONO_FAMILY, UI_FAMILY};

/// Spacing on a 4 px grid. `S1_5` is 6 px, `S0_5` is 2 px.
pub mod space {
	use super::{Pixels, px};

	pub const S0: Pixels = px(0.0);
	pub const S0_5: Pixels = px(2.0);
	pub const S1: Pixels = px(4.0);
	pub const S1_5: Pixels = px(6.0);
	pub const S2: Pixels = px(8.0);
	pub const S2_5: Pixels = px(10.0);
	pub const S3: Pixels = px(12.0);
	pub const S3_5: Pixels = px(14.0);
	pub const S4: Pixels = px(16.0);
	pub const S5: Pixels = px(20.0);
	pub const S6: Pixels = px(24.0);
	pub const S8: Pixels = px(32.0);
	pub const S10: Pixels = px(40.0);
	pub const S12: Pixels = px(48.0);
}

/// Corner radii.
pub mod radius {
	use super::{Pixels, px};

	pub const SM: Pixels = px(4.0);
	pub const MD: Pixels = px(6.0);
	pub const LG: Pixels = px(8.0);
	pub const XL: Pixels = px(12.0);
	/// Large enough to round any control into a pill.
	pub const FULL: Pixels = px(9999.0);
}

/// Fixed dimensions of the window's regions and controls.
pub mod size {
	use super::{Pixels, px};

	/// Default sidebar width, and its bounds while resizing.
	pub const SIDEBAR: Pixels = px(256.0);
	pub const SIDEBAR_MIN: Pixels = px(200.0);
	pub const SIDEBAR_MAX: Pixels = px(400.0);
	/// Default right panel width, and its bounds while resizing.
	pub const PANEL: Pixels = px(480.0);
	pub const PANEL_MIN: Pixels = px(320.0);
	pub const PANEL_MAX: Pixels = px(900.0);
	/// Default terminal drawer height, and its lower bound.
	pub const DRAWER: Pixels = px(280.0);
	pub const DRAWER_MIN: Pixels = px(120.0);
	/// Height of the thread header, which is also the window drag region.
	pub const HEADER: Pixels = px(44.0);
	/// Widest the transcript and composer column grows.
	pub const COLUMN_MAX: Pixels = px(768.0);
	/// Height of a sidebar thread row.
	pub const ROW: Pixels = px(30.0);
	/// Height of a palette or menu row.
	pub const MENU_ROW: Pixels = px(32.0);
	/// Width of the command palette.
	pub const PALETTE: Pixels = px(640.0);
	/// Height of a small, default and large control.
	pub const CONTROL_SM: Pixels = px(24.0);
	pub const CONTROL: Pixels = px(28.0);
	pub const CONTROL_LG: Pixels = px(32.0);
	/// Edge of a small and default icon.
	pub const ICON_SM: Pixels = px(14.0);
	pub const ICON: Pixels = px(16.0);
	/// Width of the hit area of a resize handle.
	pub const RESIZE_HANDLE: Pixels = px(6.0);
	/// Tallest an expanded tool output grows before it scrolls.
	pub const TOOL_OUTPUT_MAX: Pixels = px(320.0);
	/// Tallest an inline image or artifact is drawn.
	pub const MEDIA_MAX: Pixels = px(400.0);
}

/// One step of the type ramp.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TypeStyle {
	pub size:        Pixels,
	pub line_height: Pixels,
	pub weight:      FontWeight,
	pub family:      &'static str,
}

const REGULAR: FontWeight = FontWeight(400.0);
const MEDIUM: FontWeight = FontWeight(500.0);
const SEMIBOLD: FontWeight = FontWeight(600.0);

const fn ui(size: f32, line_height: f32, weight: FontWeight) -> TypeStyle {
	TypeStyle { size: px(size), line_height: px(line_height), weight, family: UI_FAMILY }
}

/// The type ramp. Weights are 400, 500 and 600 only.
pub mod text {
	use super::{MEDIUM, MONO_FAMILY, REGULAR, SEMIBOLD, TypeStyle, px, ui};

	/// Badges and dense metadata.
	pub const MICRO: TypeStyle = ui(11.0, 14.0, REGULAR);
	/// Timestamps, hints, secondary labels.
	pub const SMALL: TypeStyle = ui(12.0, 16.0, REGULAR);
	/// Controls, rows and tool summaries.
	pub const UI: TypeStyle = ui(13.0, 18.0, REGULAR);
	/// A control label that needs weight.
	pub const UI_MEDIUM: TypeStyle = ui(13.0, 18.0, MEDIUM);
	/// Transcript prose.
	pub const BODY: TypeStyle = ui(14.0, 22.0, REGULAR);
	/// Thread titles and section headings.
	pub const TITLE: TypeStyle = ui(15.0, 20.0, SEMIBOLD);
	/// Markdown level-one headings.
	pub const H1: TypeStyle = ui(20.0, 28.0, SEMIBOLD);
	/// Markdown level-two headings.
	pub const H2: TypeStyle = ui(17.0, 24.0, SEMIBOLD);
	/// Markdown level-three and deeper headings.
	pub const H3: TypeStyle = ui(15.0, 22.0, SEMIBOLD);
	/// Code blocks, tool output, terminal text.
	pub const MONO: TypeStyle =
		TypeStyle { size: px(12.5), line_height: px(18.0), weight: REGULAR, family: MONO_FAMILY };
}

/// Sets every text property of one ramp step on an element.
pub trait TypeStyled: Styled + Sized {
	/// Applies the family, size, line height and weight of `style`.
	fn type_style(self, style: TypeStyle) -> Self {
		self.font_family(style.family)
			.text_size(style.size)
			.line_height(style.line_height)
			.font_weight(style.weight)
	}
}

impl<E: Styled> TypeStyled for E {}
