//! What each region measures at a given window width (§5.7, §5.4).
//!
//! The shed is arithmetic, not rendering, so it lives here rather than inside
//! `Render`. A width that leaves the session surface with nothing is a defect
//! that must be provable without a GPU, and it is: every rule below is a pure
//! function of the viewport, the tokens and the previous label state.
//!
//! The declared breakpoint rows are the intent; this module is what makes them
//! hold at a width between two rows, where the lower row's allowance is what
//! actually fits and the upper row's is not.
//!
//! Two independent constraints decide labels. §5.7 keys them to the window,
//! which is what an operator resizes; §5.4 keys them to the composer's own
//! measure, which a docked panel narrows in a window wide enough to keep its
//! labels. Both hold, so labels appear only where both permit them.

use veyyon_desktop_tokens::{
	BreakpointConfig, ComposerSurfaceTokens, DrawerPlacement, RightPanelMode, SurfaceTokens,
};

/// Where the right panel goes, and how wide it is when it is shown.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RightPanelPlacement {
	/// No panel: nothing to show in it.
	Absent,
	/// A column beside the session surface, taking width from it.
	Inline { width_px: f32 },
	/// A float over the session surface, taking no width from it.
	Overlay { width_px: f32 },
}

impl RightPanelPlacement {
	/// The width this placement takes out of the columns row.
	#[must_use]
	pub const fn inline_width(self) -> f32 {
		match self {
			Self::Inline { width_px } => width_px,
			Self::Absent | Self::Overlay { .. } => 0.0,
		}
	}

	/// The width the panel draws at, in either placement.
	#[must_use]
	pub const fn drawn_width(self) -> f32 {
		match self {
			Self::Inline { width_px } | Self::Overlay { width_px } => width_px,
			Self::Absent => 0.0,
		}
	}
}

/// Whether the composer's footer and the run bar currently carry their labels.
///
/// Carried across frames because the decision has hysteresis: shedding and
/// restoring happen at different widths, so a drag-resize that sits on the
/// threshold settles instead of alternating every frame (§5.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LabelState {
	/// The composer footer's controls show their labels.
	pub footer:  bool,
	/// The run bar's controls show their labels.
	pub run_bar: bool,
}

impl Default for LabelState {
	/// A window opens at or above its declared minimum, where labels are shown.
	fn default() -> Self {
		Self { footer: true, run_bar: true }
	}
}

/// What the shed is asked to resolve.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShedInput {
	/// The window's width in logical pixels.
	pub viewport_px:        f32,
	/// The window's height in logical pixels. The drawer is the one region
	/// whose measure is vertical, and it is bounded by a share of this.
	pub viewport_height_px: f32,
	/// What the titlebar, and the attention strip when one is shown, take off
	/// the top of the window. Passed in rather than derived here, because
	/// whether a strip is shown is state and its height is a text measure.
	pub chrome_height_px:   f32,
	/// The horizontal inset the session column applies on each side.
	pub gutter_px:          f32,
	/// Whether the right panel has anything to show.
	pub panel_open:         bool,
	/// The label state the previous frame settled on.
	pub labels:             LabelState,
}

/// Where the terminal drawer goes at one window width, and how tall it is.
///
/// A docked row takes its height from the transcript; an overlay row takes it
/// from nothing and covers the transcript's lower edge instead. Below 980px the
/// transcript has no height to give, which is what the overlay is for (§5.7).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawerBox {
	/// Docked row or overlay row.
	pub placement: DrawerPlacement,
	/// The height the drawer draws at, in either placement.
	pub height_px: f32,
}

impl DrawerBox {
	/// The height this placement takes out of the session column.
	#[must_use]
	pub const fn column_height(self) -> f32 {
		match self.placement {
			DrawerPlacement::Row => self.height_px,
			DrawerPlacement::Overlay => 0.0,
		}
	}
}

/// What every region of the columns row measures at one window width.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShellWidths {
	/// The queue rail's width, or `None` where the breakpoint collapses it.
	pub queue_px:    Option<f32>,
	/// The right panel's placement and width.
	pub right_panel: RightPanelPlacement,
	/// What is left for the session surface.
	pub session_px:  f32,
	/// What the composer draws at inside the session surface.
	pub composer_px: f32,
	/// The height of the columns row: the window less its chrome. It is what
	/// the queue rail has to draw rows in, and the rail cannot scroll.
	pub columns_px:  f32,
	/// Where the terminal drawer goes, and how tall it is at this width.
	pub drawer:      DrawerBox,
	/// Whether the footer and the run bar carry their labels.
	pub labels:      LabelState,
}

/// Resolves every region's measure for a window width.
///
/// A panel with no content is `Absent` rather than an empty column, because an
/// empty column still takes its width away from the surface being read.
#[must_use]
pub fn shell_widths(input: ShedInput, surface: &SurfaceTokens) -> ShellWidths {
	let viewport = if input.viewport_px.is_finite() {
		input.viewport_px.max(0.0)
	} else {
		// An infinite or absent viewport width is not a layout to solve. The
		// narrowest breakpoint is the one that needs the least room, so it is
		// what a width nobody can measure gets.
		0.0
	};

	let breakpoint = surface.breakpoints.resolve(viewport);
	let queue_px = (breakpoint.queue_width_px > 0.0).then_some(breakpoint.queue_width_px);
	let right_panel = panel_placement(viewport, input.panel_open, breakpoint, surface);
	let session_px = (viewport - queue_px.unwrap_or(0.0) - right_panel.inline_width()).max(0.0);
	let composer_px = input
		.gutter_px
		.mul_add(-2.0, session_px)
		.clamp(0.0, surface.composer.max_width_px);

	ShellWidths {
		queue_px,
		right_panel,
		session_px,
		composer_px,
		columns_px: (input.viewport_height_px - input.chrome_height_px).max(0.0),
		drawer: drawer_box(input.viewport_height_px, breakpoint, surface),
		labels: labels(composer_px, breakpoint, &surface.composer, input.labels),
	}
}

/// Resolves the drawer's placement and the height it actually draws at.
///
/// The breakpoint row declares a height for the width; the window's own height
/// is what decides whether that height is available. A 280px drawer in a 300px
/// window is the transcript gone, so the declared height is cut back to the
/// share of the window the panel tokens permit. The floor applies only where
/// the window can hold it: a drawer that cannot have its minimum draws at what
/// there is rather than covering everything.
fn drawer_box(
	viewport_height_px: f32,
	breakpoint: &BreakpointConfig,
	surface: &SurfaceTokens,
) -> DrawerBox {
	let height = if viewport_height_px.is_finite() && viewport_height_px > 0.0 {
		let ceiling = viewport_height_px * surface.panels.terminal_drawer_max_viewport_ratio;
		let capped = breakpoint.terminal_drawer_height_px.min(ceiling);
		let floor = surface.panels.terminal_drawer_min_height_px.min(ceiling);
		capped.max(floor)
	} else {
		// A window height nobody can measure is not a layout to solve, and the
		// declared height is the only value there is to draw at.
		breakpoint.terminal_drawer_height_px
	};

	DrawerBox { placement: breakpoint.terminal_drawer_placement, height_px: height.max(0.0) }
}

/// Decides whether the footer and the run bar keep their labels.
fn labels(
	composer_px: f32,
	breakpoint: &BreakpointConfig,
	composer: &ComposerSurfaceTokens,
	previous: LabelState,
) -> LabelState {
	// Shedding at the threshold and restoring at the threshold plus the
	// hysteresis is what makes a drag-resize settle: the width that took the
	// labels away is not the width that brings them back.
	let keep = |was_labelled: bool, threshold: f32| {
		let restore = threshold + composer.footer_hysteresis_px;
		if was_labelled {
			composer_px >= threshold
		} else {
			composer_px >= restore
		}
	};

	LabelState {
		footer:  breakpoint.composer_footer_labels
			&& keep(previous.footer, composer.footer_compact_threshold_px),
		run_bar: breakpoint.run_bar_labels
			&& keep(previous.run_bar, composer.run_bar_compact_threshold_px),
	}
}

/// Places and measures the right panel.
fn panel_placement(
	viewport_px: f32,
	panel_open: bool,
	breakpoint: &BreakpointConfig,
	surface: &SurfaceTokens,
) -> RightPanelPlacement {
	if !panel_open {
		return RightPanelPlacement::Absent;
	}

	let panels = &surface.panels;
	// The viewport share bounds both placements: a panel wider than its share
	// of a narrow window covers the surface it is annotating.
	let share = viewport_px * panels.right_panel_max_viewport_ratio;
	let overlay = RightPanelPlacement::Overlay {
		width_px: panels
			.right_panel_default_width_px
			.min(share)
			.max(panels.right_panel_min_width_px.min(viewport_px)),
	};

	match breakpoint.right_panel_mode {
		RightPanelMode::Overlay => overlay,
		RightPanelMode::Inline { width_px } => {
			// An inline panel is bounded a third time, by what the session
			// surface must keep. Without this bound a window between two rows
			// takes the upper row's panel out of the lower row's transcript,
			// which is how the surface being read reaches zero width.
			let ceiling =
				viewport_px - breakpoint.queue_width_px - panels.right_panel_container_margin_px;
			let width = width_px.min(share).min(ceiling);

			// Below the panel's own minimum there is no inline column to draw:
			// it overlays instead, so it stays reachable at its real measure
			// rather than becoming a sliver of a tree.
			if width < panels.right_panel_min_width_px {
				overlay
			} else {
				RightPanelPlacement::Inline { width_px: width }
			}
		},
	}
}
