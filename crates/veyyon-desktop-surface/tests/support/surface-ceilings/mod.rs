//! What the §6.6 sweep measures with: the scope each surface class is judged
//! over, the state it is read in, the frame a verdict is read from, and the
//! census a breach is reported with.

use std::{path::Path, sync::Arc};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::tool_view::{
	StatusRowView, ToolPresentation, ToolView, ViewStatus, ViewTone,
};
use veyyon_desktop_scene::{
	HeadlessSession, RgbaColor,
	headless::{Captured, Headless, RenderOptions},
	logical_box,
	measure::{measure, rhythm_spans, text_sizes},
	metrics::{SurfaceClass, check},
};
use veyyon_desktop_surface::{
	ShellView,
	damage::{LaidOut, Region},
	fixture, install_tokens,
	model::{Block, Turn},
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels};

pub const HEIGHT: u32 = 900;
pub const APPEARANCES: [&str; 2] = ["dark", "light"];

/// What a class is judged over: the whole frame, or each box the frame
/// recorded for it.
///
/// Total over the enum on purpose: a §6.6 row added to `SurfaceClass` fails to
/// compile until it names the region that carries it, because a class measured
/// over the wrong box is a ceiling checked against a neighbour.
pub fn scope_of(class: SurfaceClass, recorded: &[Region]) -> Option<Vec<Region>> {
	let matching = |keep: fn(&Region) -> bool| -> Option<Vec<Region>> {
		Some(recorded.iter().copied().filter(keep).collect())
	};
	match class {
		SurfaceClass::WholeWindow => None,
		SurfaceClass::QueueRowCard => matching(|r| matches!(r, Region::QueueCardRow(_))),
		SurfaceClass::QueueRowLine => matching(|r| matches!(r, Region::QueueLineRow(_))),
		SurfaceClass::TranscriptTurn => matching(|r| matches!(r, Region::Turn(_))),
		SurfaceClass::BlockChrome => matching(|r| matches!(r, Region::Block(_, _))),
		SurfaceClass::Composer => matching(|r| matches!(r, Region::Composer)),
		SurfaceClass::RightPanelChrome => matching(|r| matches!(r, Region::PanelChrome)),
		SurfaceClass::TerminalDrawerChrome => matching(|r| matches!(r, Region::DrawerChrome)),
	}
}

/// Whether this class draws inside the queue rail, which is the surface §5.7
/// sheds at the collapsed tier.
pub const fn rides_the_rail(class: SurfaceClass) -> bool {
	matches!(class, SurfaceClass::QueueRowCard | SurfaceClass::QueueRowLine)
}

/// The state a class is measured in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pass {
	/// Nothing floating, pointer parked off the transcript.
	Plain,
	/// The right panel on screen, which is the only state its chrome exists
	/// in and a state that floats over the transcript below 980px.
	Panel,
	/// The terminal drawer on screen, which is the only state its chrome
	/// exists in and a state that floats over the composer at the collapsed
	/// tier.
	Drawer,
	/// The pointer on the surface being measured, which is where §5.3 reveals
	/// a turn's own actions.
	Hovered,
}

impl Pass {
	pub const ALL: [Self; 4] = [Self::Plain, Self::Panel, Self::Drawer, Self::Hovered];

	/// Whether a class in this pass is read once per box with the pointer on
	/// it, since the pointer can only be on one box at a time.
	pub const fn is_per_box(self) -> bool {
		matches!(self, Self::Hovered)
	}
}

/// Where a class is read.
///
/// Total over the enum on purpose: a §6.6 row added to `SurfaceClass` fails to
/// compile until it states the state it is measured in, because a surface read
/// under a float is charged for a neighbour's ink and one read without the
/// pointer that reveals its controls is charged for a density it never has.
pub const fn pass_of(class: SurfaceClass) -> Pass {
	match class {
		SurfaceClass::WholeWindow | SurfaceClass::BlockChrome | SurfaceClass::Composer => Pass::Plain,
		SurfaceClass::RightPanelChrome => Pass::Panel,
		SurfaceClass::TerminalDrawerChrome => Pass::Drawer,
		// A rail row and a turn keep their own actions until the pointer is on
		// them (§5.2, §5.3), and a clutter ceiling is a ceiling on the state
		// the surface is densest in.
		SurfaceClass::QueueRowCard | SurfaceClass::QueueRowLine | SurfaceClass::TranscriptTurn => {
			Pass::Hovered
		},
	}
}

/// A host-supplied view of one call, which is what makes a collapsed card's
/// row spend the two controls its §6.6 row authors: the row's own disclosure,
/// and the target its description names.
fn presented_call() -> Arc<ToolPresentation> {
	Arc::new(ToolPresentation {
		expanded: false,
		view:     ToolView::StatusRow(StatusRowView {
			status: Some(ViewStatus::Success),
			title: "Read 207 lines".into(),
			title_tone: Some(ViewTone::Title),
			description: Some("crates/veyyon-desktop-tokens/src/surface.rs".into()),
			description_fits: true,
			description_file: Some("crates/veyyon-desktop-tokens/src/surface.rs".into()),
			description_file_line: Some(12),
			..StatusRowView::default()
		}),
	})
}

/// Opens the populated shell with each float on screen only for the pass that
/// measures it, and the first tool card carrying a host view so the block
/// classes are read at the shape their row is authored for.
pub fn open_shell<'a>(
	cx: &'a mut Headless,
	width: u32,
	appearance: &str,
	pass: Pass,
) -> HeadlessSession<'a, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme(appearance).expect("the bundled theme loads");
	let options =
		RenderOptions { width, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		let mut state = if pass == Pass::Drawer {
			fixture::with_drawer()
		} else {
			fixture::populated()
		};
		state.keymap.panel_collapsed = pass != Pass::Panel;
		for turn in &mut state.transcript {
			if let Turn::Agent { blocks, .. } = turn {
				for block in blocks.iter_mut() {
					if let Block::Invoke { views, .. } = block {
						views.result = Some(presented_call());
					}
				}
			}
		}
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the session opens offscreen")
}

/// The frame a verdict is read from, with the regions that frame laid out.
///
/// The first two frames settle the layout. The boxes are then forgotten, so
/// the set the measured frame records is its own: the transcript retains its
/// rows, and a box left behind by a row this frame did not lay out would hand
/// these pixels to the last frame's geometry.
pub fn measured_frame(session: &mut HeadlessSession<'_, ShellView>) -> (Captured, Vec<Region>) {
	session.frame().expect("the first frame renders");
	session.frame().expect("the settling frame renders");
	session
		.update(|view, window, _cx| {
			view.laid_out().forget();
			window.refresh();
		})
		.expect("the view is live");
	let captured = session.frame().expect("the measured frame renders");
	let recorded = session
		.update(|view, _window, _cx| view.laid_out().recorded_regions())
		.expect("the view is live");
	(captured, recorded)
}

/// The four breakpoint tiers of `breakpoints.toml`, wide to collapsed, read
/// from the token file so a retuned tier moves the gate with it.
pub fn tier_widths() -> [u32; 4] {
	let breakpoints = load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface
		.breakpoints;
	[
		breakpoints.wide.min_width_px,
		breakpoints.standard.min_width_px,
		breakpoints.compact.min_width_px,
		breakpoints.collapsed.min_width_px,
	]
	.map(|px| px.round() as u32)
}

/// Every breach of `class` over `part`, named for the cell and the box.
///
/// Under `VEYYON_SURFACE_SPEND` every measured box states what it spends, and
/// under `VEYYON_CONVERGENCE_PROBE` a breaching one also states the hit rects
/// it spends it on: a §6.6 row is retuned from the census, not from a count
/// somebody remembers.
pub fn breaches_of(
	part: &Captured,
	ground: RgbaColor,
	class: SurfaceClass,
	tokens: &veyyon_desktop_tokens::CeilingTokens,
	cell: &str,
	name: &str,
) -> Vec<String> {
	let measured = measure(part, ground);
	let breaches: Vec<String> = check(&measured, class, tokens)
		.breaches()
		.iter()
		.map(|breach| {
			format!(
				"{cell}: {} at {name}: {} measured {} over the {} ceiling",
				class.name(),
				breach.metric,
				breach.actual,
				breach.ceiling
			)
		})
		.collect();
	let spend = std::env::var_os("VEYYON_SURFACE_SPEND").is_some();
	if spend {
		println!(
			"{cell} {} at {name}: {}x{} px, {:.2} edges, {} gaps, {} sizes, {} controls",
			class.name(),
			part.frame.logical_width(),
			part.frame.logical_height(),
			measured.metrics.edge_count,
			measured.metrics.distinct_gaps,
			measured.metrics.distinct_text_sizes,
			measured.interactive,
		);
	}
	if !breaches.is_empty() && std::env::var_os("VEYYON_CONVERGENCE_PROBE").is_some() {
		println!(
			"{cell} {} at {name}: {}x{} px, {} controls of hit rects {:?}, sizes {:?}, gaps {:?}",
			class.name(),
			part.frame.logical_width(),
			part.frame.logical_height(),
			measured.interactive,
			part
				.hitboxes
				.iter()
				.map(|hit| logical_box(*hit))
				.collect::<Vec<_>>(),
			text_sizes(part),
			rhythm_spans(part).keys().collect::<Vec<_>>(),
		);
	}
	breaches
}

/// Whether a laid-out box has pixels in the frame at all.
///
/// A retained transcript lays out the rows either side of its viewport, and one
/// scrolled past the live edge paints nothing: it is absent from the frame
/// rather than a §6.6 row that reached no measurement.
pub fn on_screen(bounds: Bounds<Pixels>, part: &Captured) -> bool {
	let held = logical_box(bounds);
	held.right > 0.0
		&& held.bottom > 0.0
		&& held.left < part.frame.logical_width()
		&& held.top < part.frame.logical_height()
}

/// The boxes of the blocks `turn` holds, which carry their own §6.6 row.
pub fn blocks_of(turn: usize, recorded: &[Region], boxes: &LaidOut) -> Vec<Bounds<Pixels>> {
	recorded
		.iter()
		.filter(|region| matches!(region, Region::Block(owner, _) if *owner == turn))
		.filter_map(|region| boxes.drawn_bounds(*region))
		.collect()
}
