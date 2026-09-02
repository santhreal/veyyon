//! Which regions the next frame draws differently, and where the last frame
//! put them (P5).
//!
//! The renderer fork repaints only what a frame declares, and a scoped frame is
//! correct only when every pixel that changes lies inside the declared
//! rectangle. This module answers the two questions that need: which regions
//! the next state draws differently from the last one, and the box the last
//! frame laid each region out in. The app combines them into one scoped
//! notify per changed region. A change that moves layout, a panel opening or
//! a drawer docking, is reported as full, because a box that was not there
//! last frame has no bounds to scope to.
//!
//! A recorded box also makes a layout shift self-declaring. A region whose box
//! differs from the last frame's declares the union of the two while the frame
//! is being prepainted, so a bottom-anchored transcript whose last turn grew a
//! line repaints the turns that slid up as well as the one that grew.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use veyyon_gpui::{Bounds, Div, Pixels, Size, Window, px};

/// How far past a region's laid-out box its paint can reach, in logical
/// pixels. Text is set on line boxes tighter than the font's natural
/// metrics, so a glyph's descent and antialiasing paint below the box its
/// element was laid out in, and an italic overhang paints past the sides. A
/// scoped frame is built from these boxes, so the box is inflated by the
/// margin before it becomes damage: the margin is the one place that knows a
/// laid-out box is not a painted extent. 12 covers the tightest ramp's
/// descent plus antialiasing with headroom; the cost is a few extra painted
/// rows per scoped frame.
const RASTER_MARGIN_PX: f32 = 12.0;

/// The box `bounds` covers, grown by the raster margin on every side.
fn with_raster_margin(bounds: Bounds<Pixels>) -> Bounds<Pixels> {
	let margin = px(RASTER_MARGIN_PX);
	Bounds {
		origin: bounds.origin - veyyon_gpui::point(margin, margin),
		size:   Size {
			width:  bounds.size.width + margin * 2.0,
			height: bounds.size.height + margin * 2.0,
		},
	}
}

use crate::model::ShellState;

/// A region of the shell a state change can confine its repaint to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Region {
	/// The titlebar: window controls, the title, the drawer control.
	Titlebar,
	/// The queue rail, headers and rows.
	Queue,
	/// The transcript body, opening line included.
	Transcript,
	/// One turn of the transcript, by index.
	Turn(usize),
	/// The card stack above the composer.
	Cards,
	/// The composer.
	Composer,
	/// The run bar.
	RunBar,
	/// The right panel.
	Panel,
	/// The terminal drawer.
	Drawer,
}

/// What the next frame has to repaint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invalidation {
	/// The two states draw the same pixels.
	Nothing,
	/// Only these regions draw differently.
	Within(Vec<Region>),
	/// Layout moved, or a region with no box of its own changed.
	Full,
}

/// The boxes the last prepaint laid each region out in.
///
/// Held by handle: a prepaint listener is `'static` and outlives the render
/// that installed it, and the app reads the boxes between frames.
#[derive(Clone, Default)]
pub struct LaidOut {
	boxes: Rc<RefCell<HashMap<Region, Bounds<Pixels>>>>,
}

impl LaidOut {
	/// The box the last frame laid `region` out in, absent when no frame has
	/// laid it out yet.
	pub fn bounds(&self, region: Region) -> Option<Bounds<Pixels>> {
		self.boxes.borrow().get(&region).copied()
	}

	/// Records the box a region was just prepainted into. When the box differs
	/// from the last frame's, the union of the two is declared as damage, so
	/// the pixels the region vacated are repainted along with the ones it now
	/// covers. The recorded box carries the raster margin, because what the
	/// box is FOR is damage, and damage has to cover the paint, not the layout.
	pub fn record(&self, region: Region, bounds: Bounds<Pixels>, window: &mut Window) {
		let bounds = with_raster_margin(bounds);
		let previous = self.boxes.borrow_mut().insert(region, bounds);
		if previous != Some(bounds) {
			window.declare_damage(previous.map_or(bounds, |previous| previous.union(&bounds)));
		}
	}

	/// Records each child of `div` under the region `region_of` assigns to its
	/// index, at every prepaint. A child with no region is not recorded.
	pub fn track_children(
		&self,
		div: Div,
		region_of: impl Fn(usize) -> Option<Region> + 'static,
	) -> Div {
		let laid_out = self.clone();
		div.on_children_prepainted(move |children, window, _| {
			for (index, bounds) in children.into_iter().enumerate() {
				if let Some(region) = region_of(index) {
					laid_out.record(region, bounds, window);
				}
			}
		})
	}
}

/// The regions `next` draws differently from `last`.
///
/// The destructure is exhaustive on purpose: a field added to `ShellState`
/// fails to compile here until it is assigned a region or declared a full
/// repaint, which is the decision a new field owes this diff. A field that
/// went undiffed would change pixels a scoped frame never repaints.
pub fn regions_changed(last: &ShellState, next: &ShellState) -> Invalidation {
	let ShellState {
		title,
		sections,
		transcript,
		turn,
		run_status,
		panel,
		cards,
		drawer,
		drawer_open,
		current_id,
		connection,
		controls,
		overlay,
		keymap,
		composer,
	} = next;

	// Anything that moves layout, or changes a surface that records no box of
	// its own, repaints the window. The turn phase and the control states
	// reach the composer's footer and the titlebar's controls at once, and
	// the keymap state reaches every focused control.
	if current_id != &last.current_id
		|| drawer_open != &last.drawer_open
		|| panel.is_empty() != last.panel.is_empty()
		|| cards.is_empty() != last.cards.is_empty()
		|| turn != &last.turn
		|| connection != &last.connection
		|| controls != &last.controls
		|| overlay != &last.overlay
		|| keymap != &last.keymap
		|| composer != &last.composer
	{
		return Invalidation::Full;
	}

	let mut regions = Vec::new();
	if title != &last.title {
		regions.push(Region::Titlebar);
	}
	if sections != &last.sections {
		regions.push(Region::Queue);
	}
	transcript_regions(&last.transcript, transcript, &mut regions);
	if run_status != &last.run_status {
		regions.push(Region::RunBar);
	}
	if panel != &last.panel {
		regions.push(Region::Panel);
	}
	if cards != &last.cards {
		regions.push(Region::Cards);
	}
	if drawer != &last.drawer {
		regions.push(Region::Drawer);
	}

	// The tail of the transcript is what the composer's float blurs: the
	// float sits a hair below the last turn's box, and its backdrop blur
	// samples the gap between them. A change confined to the last turn still
	// changes pixels inside the float, so the regions below it repaint with
	// it. Without this a scoped frame either leaves the float stale or its
	// scissor slices the blur, which samples stale pixels across the cut.
	if regions.iter().any(
		|region| matches!(region, Region::Turn(index) if *index == transcript.len().saturating_sub(1)),
	) {
		if !cards.is_empty() {
			regions.push(Region::Cards);
		}
		regions.push(Region::Composer);
	}

	if regions.is_empty() {
		Invalidation::Nothing
	} else if overlay.is_some() {
		// The overlay's scrim blurs the whole columns row, so a change beneath
		// it reaches pixels far outside its own region. A scissor through a
		// blur samples stale pixels across the cut; the frame repaints whole.
		Invalidation::Full
	} else {
		Invalidation::Within(regions)
	}
}

/// The transcript's changed turns, by index.
///
/// A turn appended is its own region, and the turns it pushed up declare
/// themselves when they are prepainted into new boxes. A turn removed leaves
/// pixels no surviving turn is laid out over, so a shrink, and the switch from
/// the opening line to a column, repaint the whole body.
fn transcript_regions(
	last: &[crate::model::Turn],
	next: &[crate::model::Turn],
	regions: &mut Vec<Region>,
) {
	if next.len() < last.len() || last.is_empty() != next.is_empty() {
		if last != next {
			regions.push(Region::Transcript);
		}
		return;
	}
	regions.extend(
		next
			.iter()
			.enumerate()
			.filter(|(index, turn)| last.get(*index) != Some(*turn))
			.map(|(index, _)| Region::Turn(index)),
	);
}
