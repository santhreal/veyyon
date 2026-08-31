//! Geometry tokens: the boxes text and controls sit in.
//!
//! Split from [`super::tokens`] so neither file passes the four-hundred-line
//! ceiling. Every metric here holds a glyph, so it is a function of the
//! interface scale rather than a constant; the fixed geometry that shares the
//! `layout` module states why it is fixed.

use super::scale::scaled;

pub mod row {
	use super::scaled;

	const COMPACT_PX: f32 = 28.0;
	const NORMAL_PX: f32 = 32.0;
	const ROOMY_PX: f32 = 36.0;
	const TWO_LINE_PX: f32 = 48.0;

	pub fn compact() -> f32 {
		scaled(COMPACT_PX)
	}

	pub fn normal() -> f32 {
		scaled(NORMAL_PX)
	}

	pub fn roomy() -> f32 {
		scaled(ROOMY_PX)
	}

	pub fn two_line() -> f32 {
		scaled(TWO_LINE_PX)
	}
}

pub mod icon {
	use super::scaled;

	const SMALL_PX: f32 = 14.0;
	const NORMAL_PX: f32 = 16.0;
	const LARGE_PX: f32 = 18.0;
	const OPTICAL_BOX_PX: f32 = 20.0;

	pub fn small() -> f32 {
		scaled(SMALL_PX)
	}

	pub fn normal() -> f32 {
		scaled(NORMAL_PX)
	}

	pub fn large() -> f32 {
		scaled(LARGE_PX)
	}

	/// The box an icon is centred in, so a glyph of any width sits on the same
	/// optical column as the one above it.
	pub fn optical_box() -> f32 {
		scaled(OPTICAL_BOX_PX)
	}
}

pub mod control {
	use super::scaled;

	const SWITCH_WIDTH_PX: f32 = 36.0;
	const SWITCH_HEIGHT_PX: f32 = 20.0;
	/// The box every small control draws: a switch knob, a checkbox and a radio
	/// are one size, so a settings column of all three reads as one column.
	const BOX_PX: f32 = 16.0;
	const CHECKBOX_MARK_PX: f32 = 12.0;
	const RADIO_DOT_PX: f32 = 8.0;
	const MENU_WIDTH_PX: f32 = 240.0;
	const ACTION_SLOT_PX: f32 = 36.0;
	const STEPPER_VALUE_WIDTH_PX: f32 = 52.0;

	pub fn switch_width() -> f32 {
		scaled(SWITCH_WIDTH_PX)
	}

	pub fn switch_height() -> f32 {
		scaled(SWITCH_HEIGHT_PX)
	}

	pub fn switch_knob() -> f32 {
		scaled(BOX_PX)
	}

	pub fn checkbox() -> f32 {
		scaled(BOX_PX)
	}

	pub fn checkbox_mark() -> f32 {
		scaled(CHECKBOX_MARK_PX)
	}

	pub fn radio() -> f32 {
		scaled(BOX_PX)
	}

	pub fn radio_dot() -> f32 {
		scaled(RADIO_DOT_PX)
	}

	/// A menu holds text, so it widens with the text.
	pub fn menu_width() -> f32 {
		scaled(MENU_WIDTH_PX)
	}

	pub fn action_slot() -> f32 {
		scaled(ACTION_SLOT_PX)
	}

	pub fn two_action_slots() -> f32 {
		action_slot() * 2.0
	}

	pub fn stepper_value_width() -> f32 {
		scaled(STEPPER_VALUE_WIDTH_PX)
	}

	/// The switch knob's inset, the bar a partly-on checkbox draws, and the
	/// focus ring: these are strokes and gaps rather than boxes holding a
	/// glyph, and a two-pixel ring is two pixels at every text size.
	pub const SWITCH_INSET: f32 = 2.0;
	pub const CHECKBOX_BAR: f32 = 2.0;
	pub const FOCUS_RING: f32 = 2.0;
}

pub mod layout {
	use super::scaled;

	const TITLEBAR_PX: f32 = 38.0;
	const TOOLBAR_PX: f32 = 40.0;
	const ACTIVITY_RAIL_PX: f32 = 48.0;
	const READING_PX: f32 = 720.0;
	const CONTROL_HEIGHT_PX: f32 = 32.0;
	const EDITOR_SINGLE_LINE_PX: f32 = 32.0;
	const COMPOSER_MIN_HEIGHT_PX: f32 = 52.0;
	const COMPOSER_MAX_HEIGHT_PX: f32 = 220.0;
	const FADE_BAND_PX: f32 = 24.0;
	const FADE_BAND_TIGHT_PX: f32 = 12.0;
	const MEASURE_PX: f32 = 480.0;
	const CONVERSATION_WIDE_PX: f32 = 1040.0;

	// Chrome that holds a row of text and controls.
	pub fn titlebar() -> f32 {
		scaled(TITLEBAR_PX)
	}

	pub fn toolbar() -> f32 {
		scaled(TOOLBAR_PX)
	}

	/// The rail holds only icons, and it is the window's left edge, so it
	/// widens with the icons rather than staying a fixed strip a larger glyph
	/// would overflow.
	pub fn activity_rail() -> f32 {
		scaled(ACTIVITY_RAIL_PX)
	}

	/// The measure prose is set to: about 70 characters at the base size, so it
	/// is derived from the text and moves with it.
	pub fn reading() -> f32 {
		scaled(READING_PX)
	}

	pub fn control_height() -> f32 {
		scaled(CONTROL_HEIGHT_PX)
	}

	pub fn editor_single_line() -> f32 {
		scaled(EDITOR_SINGLE_LINE_PX)
	}

	pub fn composer_min_height() -> f32 {
		scaled(COMPOSER_MIN_HEIGHT_PX)
	}

	pub fn composer_max_height() -> f32 {
		scaled(COMPOSER_MAX_HEIGHT_PX)
	}

	/// How deep a scroll region's content dissolves into its own edge. Read as
	/// two rows of body text: shallower reads as a smudge on the first row,
	/// deeper fades a row that is still being read.
	pub fn fade_band() -> f32 {
		scaled(FADE_BAND_PX)
	}

	/// The band for a region whose edge is a hairline rather than chrome: a
	/// menu, an inspector list, a code well.
	pub fn fade_band_tight() -> f32 {
		scaled(FADE_BAND_TIGHT_PX)
	}

	pub fn row_tight() -> f32 {
		super::row::compact()
	}

	pub fn row() -> f32 {
		super::row::normal()
	}

	pub fn row_tall() -> f32 {
		super::row::two_line()
	}

	/// The measure a note, a chip label, a bubble and a palette row wrap at:
	/// about forty characters at the base size.
	pub fn measure() -> f32 {
		scaled(MEASURE_PX)
	}

	/// The measure the conversation takes in a window wide enough for it. The
	/// breakpoint that turns it on is fixed, because it is a question about the
	/// window; this is a question about the text.
	pub fn conversation_wide() -> f32 {
		scaled(CONVERSATION_WIDE_PX)
	}

	// Fixed geometry. A panel width is the reader's to drag and is clamped
	// against the window, a breakpoint decides what fits at a given window
	// width, and the platform's window controls are the platform's size
	// whatever the text does.
	pub const TITLEBAR_INSET: f32 = 12.0;
	pub const MACOS_TRAFFIC_LIGHT_CLEARANCE: f32 = 72.0;
	pub const WINDOW_CONTROL_HIT: f32 = 32.0;
	pub const WINDOW_CONTROL_CLUSTER: f32 = 138.0;
	pub const SIDEBAR: f32 = 256.0;
	pub const SIDEBAR_MIN: f32 = 200.0;
	pub const SIDEBAR_MAX: f32 = 400.0;
	pub const INSPECTOR: f32 = 340.0;
	pub const INSPECTOR_MIN: f32 = 280.0;
	pub const INSPECTOR_MAX: f32 = 480.0;
	pub const BOTTOM_DOCK: f32 = 240.0;
	pub const BOTTOM_DOCK_MIN: f32 = 180.0;
	pub const CONVERSATION_WIDE_BREAKPOINT: f32 = 1280.0;
	pub const SHEET: f32 = 640.0;
	pub const OVERLAY_MARGIN: f32 = 16.0;
	pub const SHEET_TOP: f32 = 96.0;
	pub const HANDLE: f32 = 4.0;
	pub const HANDLE_HIT: f32 = 12.0;
	pub const CONTROL: f32 = 12.0;
	pub const SCROLLBAR: f32 = 8.0;
	pub const MIN_WINDOW_WIDTH: f32 = 820.0;
	pub const MIN_WINDOW_HEIGHT: f32 = 560.0;
	pub const BREAKPOINT_INLINE: f32 = 1180.0;
	pub const BREAKPOINT_SIDEBAR_SHEET: f32 = 920.0;
}

pub mod diff {
	use super::scaled;

	const LINE_HEIGHT_PX: f32 = 20.0;
	const HUNK_HEADER_HEIGHT_PX: f32 = 28.0;
	const FILE_HEADER_HEIGHT_PX: f32 = 36.0;
	const LINE_NUMBER_GUTTER_PX: f32 = 52.0;
	const MARKER_GUTTER_PX: f32 = 18.0;

	/// A diff line holds mono text, which scales, so the row it sits in and the
	/// gutters beside it scale with it or the text clips.
	pub fn line_height() -> f32 {
		scaled(LINE_HEIGHT_PX)
	}

	pub fn hunk_header_height() -> f32 {
		scaled(HUNK_HEADER_HEIGHT_PX)
	}

	pub fn file_header_height() -> f32 {
		scaled(FILE_HEADER_HEIGHT_PX)
	}

	pub fn line_number_gutter() -> f32 {
		scaled(LINE_NUMBER_GUTTER_PX)
	}

	pub fn marker_gutter() -> f32 {
		scaled(MARKER_GUTTER_PX)
	}

	pub fn toolbar_height() -> f32 {
		super::layout::toolbar()
	}

	pub const SPLIT_DIVIDER: f32 = 1.0;
	pub const NARROW_INSPECTOR: f32 = super::layout::INSPECTOR_MIN;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponsiveLayout {
	Inline,
	InspectorSheet,
	SidebarAndInspectorSheets,
}

pub fn responsive_layout(width: f32) -> ResponsiveLayout {
	if width >= layout::BREAKPOINT_INLINE {
		ResponsiveLayout::Inline
	} else if width >= layout::BREAKPOINT_SIDEBAR_SHEET {
		ResponsiveLayout::InspectorSheet
	} else {
		ResponsiveLayout::SidebarAndInspectorSheets
	}
}
