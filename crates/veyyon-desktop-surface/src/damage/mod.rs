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

use veyyon_gpui::{Bounds, Div, Pixels, Point, Size, Window, div, px};

mod changed;

pub use self::changed::regions_changed;
use crate::model::ShellState;

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

/// The box `bounds` covers with that margin taken back off, which is the
/// extent the element occupied rather than the extent a repaint of it covers.
fn without_raster_margin(bounds: Bounds<Pixels>) -> Bounds<Pixels> {
	let margin = px(RASTER_MARGIN_PX);
	Bounds {
		origin: bounds.origin + veyyon_gpui::point(margin, margin),
		size:   Size {
			width:  bounds.size.width - margin * 2.0,
			height: bounds.size.height - margin * 2.0,
		},
	}
}

/// A region of the shell a state change can confine its repaint to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Region {
	/// The titlebar: window controls, the title, the drawer control.
	Titlebar,
	/// The queue rail, headers and rows.
	Queue,
	/// One card-shaped row of the rail, by the rail's own item index.
	///
	/// A row records its own box for the same reason a turn does: its box
	/// moves when a section above it collapses, and a region whose box moved
	/// declares the union of the two so the pixels it vacated repaint. The
	/// shape is in the variant because a card and a line are capped
	/// differently (§6.6) and the index alone does not state which one drew.
	QueueCardRow(usize),
	/// One line-shaped row of the rail, by the rail's own item index.
	QueueLineRow(usize),
	/// The transcript body, opening line included.
	Transcript,
	/// One turn of the transcript, by index.
	Turn(usize),
	/// One block of one turn, by turn index and position within the turn.
	Block(usize, usize),
	/// The card stack above the composer.
	Cards,
	/// The composer.
	Composer,
	/// The run bar.
	RunBar,
	/// The right panel.
	Panel,
	/// The right panel's chrome: its tab strip, without the view under it.
	///
	/// §6.6 caps the panel's chrome and the drawer's chrome, not the content
	/// they frame: a tree with two hundred rows and a terminal grid of prose
	/// are content, and a ceiling that counted them would be a ceiling on how
	/// much a session did.
	PanelChrome,
	/// The terminal drawer.
	Drawer,
	/// The drawer's chrome: its tab strip and toolbar, without the tenant.
	DrawerChrome,
	/// The cells of the terminal grid, without the drawer's chrome or its
	/// padding.
	///
	/// The box is what the grid is measured in: how many columns and rows
	/// the window has room for is read off it, so the emulator holds the
	/// text at the width it is drawn at.
	TerminalGrid,
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

	/// Every region the last frame laid out, in variant order.
	///
	/// The set is the frame's own, so a caller stating something about all of
	/// them — a float that may only cover what it annotates, a repaint that
	/// may only touch one — covers a region added later without naming it.
	pub fn recorded_regions(&self) -> Vec<Region> {
		let mut regions: Vec<Region> = self.boxes.borrow().keys().copied().collect();
		regions.sort_unstable();
		regions
	}

	/// Drops every recorded box, so the set the next frame records is that
	/// frame's own.
	///
	/// A box outlives the frame that recorded it on purpose: damage is the
	/// union of where a region was and where it is. A measurement is the
	/// opposite: a §6.6 verdict on a box the current frame did not lay out
	/// reads this frame's pixels through the last frame's geometry, so a
	/// caller that measures forgets first.
	pub fn forget(&self) {
		self.boxes.borrow_mut().clear();
	}

	/// The extent `region` occupied, which is the recorded box with the raster
	/// margin taken back off: where a press has to land to reach the element,
	/// rather than where a repaint of it has to paint.
	pub fn drawn_bounds(&self, region: Region) -> Option<Bounds<Pixels>> {
		self.bounds(region).map(without_raster_margin)
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

	/// A fresh div that records its children the same way, for a container
	/// whose own chain has to come after the listener.
	///
	/// `on_children_prepainted` is a `Div` method and `id` returns a
	/// `Stateful<Div>`, so a container that carries an element id installs
	/// the listener first and chains the rest onto what this returns.
	pub fn tracking(&self, region_of: impl Fn(usize) -> Option<Region> + 'static) -> Div {
		self.track_children(div(), region_of)
	}
}

/// The box an animating transcript repaints inside.
///
/// The caret of a streaming reply and a block's reveal both draw in the last
/// turn, and that turn's tail is what the composer's float blurs, so the
/// float and the card stack over it repaint with it for the reason
/// [`regions_changed`] states. A scroll spring moves every turn, and each
/// one declares the box it left along with the box it took as it re-records,
/// so the turns above this one need no room here.
///
/// `None` when one of those has no box yet, which is the same answer that
/// path gives: repaint the frame whole rather than guess where the motion
/// lands.
#[must_use]
pub fn motion_damage(state: &ShellState, laid_out: &LaidOut) -> Option<Bounds<Pixels>> {
	let last_turn = state.transcript.len().checked_sub(1)?;
	let mut union = laid_out.bounds(Region::Turn(last_turn))?;
	if !state.cards.is_empty() {
		union = union.union(&laid_out.bounds(Region::Cards)?);
	}
	Some(union.union(&laid_out.bounds(Region::Composer)?))
}

/// Asks for the frame an animation needs, repainting `bounds` alone.
///
/// A surface mid-animation asks for the next frame while painting this one.
/// Asking without bounds repaints the window, and a caret that blinks for
/// the length of a streamed reply asks on every frame of the turn, so the
/// box the motion reaches is declared on this paint and the frame is scoped
/// to it.
///
/// A frame draws into the buffer the window presented two frames ago, so it
/// repaints what this frame changes and what the one before it changed; the
/// window carries one frame of declared damage forward for exactly that. A
/// frame that repaints everything therefore has to be followed by one that
/// repaints everything, and a motion asking from inside such a frame states
/// that as the viewport rectangle rather than as an unscoped notify. An
/// unscoped notify leaves the next frame with nothing to carry, so the
/// motion inside it asks unscoped again and every frame after it repaints
/// the window; the rectangle carries once and the frame after it is scoped
/// again.
pub fn request_motion_frame(window: &mut Window, bounds: Option<Bounds<Pixels>>) {
	let scoped = bounds.filter(|_| window.pending_damage().is_some());
	let bounds = scoped.unwrap_or_else(|| Bounds::new(Point::default(), window.viewport_size()));
	window.declare_damage(bounds);
	window.request_animation_frame_at_paint();
}
