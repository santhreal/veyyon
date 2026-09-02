//! Tiling many rendered frames into one labelled image.
//!
//! This is what turns a render into a judgement. Fifty states side by side
//! catch the state that was forgotten, the state whose delta is invisible, and
//! the state that reads more urgent than the urgent one; twelve candidate
//! values of one token in one look replace twelve serial edits. A caption under
//! each cell carries the measurements, so "cluttered" is read as numbers next
//! to the frame that produced them rather than argued about.
//!
//! The sheet is itself a rendered scene: cells are image elements and captions
//! are text, composed through the same headless path as their contents. That
//! keeps one text shaper and one renderer in play rather than a second,
//! hand-rolled glyph blitter that would disagree with the frames it labels.

use std::sync::Arc;

use image::{ImageBuffer, Rgba};
use smallvec::SmallVec;
use veyyon_gpui::{
	App, AppContext, Context, ImageSource, IntoElement, ParentElement, Render, RenderImage, Styled,
	Window, div, img, px, rgb,
};

use crate::{
	frame::{RgbaColor, RgbaFrame},
	headless::{RenderError, RenderOptions, render_view},
	layout::LayoutBoxTree,
	metrics::{ClutterMetrics, compute_metrics},
};

/// Sheet chrome, in logical pixels. Values are held here rather than read from
/// the token files because a contact sheet is a measuring instrument, not a
/// product surface: its own chrome must not move when the tokens under test do,
/// or every cell's caption would shift between two arms of a sweep.
const CELL_BORDER: f32 = 1.0;
const CELL_GAP: f32 = 16.0;
const CAPTION_HEIGHT: f32 = 46.0;
const CAPTION_PAD_TOP: f32 = 6.0;
const CAPTION_LINE_GAP: f32 = 2.0;
const CAPTION_LABEL_SIZE: f32 = 12.0;
const CAPTION_DETAIL_SIZE: f32 = 10.0;
const SHEET_PADDING: f32 = 20.0;
const SHEET_GROUND: u32 = 0x0b_0b_0e;
const CELL_EDGE: u32 = 0x33_33_33;
const CAPTION_INK: u32 = 0xb8_be_cb;
const CAPTION_DIM: u32 = 0x77_7e_8b;

/// One cell: a rendered frame, what to call it, and what it measured.
pub struct SheetCell {
	pub label:   String,
	pub frame:   RgbaFrame,
	/// Absent when the scene supplied no layout tree. Four of the six metrics
	/// are computed from the layout tree rather than the pixels, so a cell
	/// without one reports the geometry and omits the numbers instead of
	/// printing zeros that would read as measurements.
	pub metrics: Option<ClutterMetrics>,
}

impl SheetCell {
	pub fn new(label: impl Into<String>, frame: RgbaFrame) -> Self {
		Self { label: label.into(), frame, metrics: None }
	}

	pub const fn with_metrics(mut self, metrics: ClutterMetrics) -> Self {
		self.metrics = Some(metrics);
		self
	}

	/// Constructs a cell from a rendered frame and its layout box tree,
	/// computing the six clutter metrics against the specified ground colour.
	pub fn from_rendered(
		label: impl Into<String>,
		frame: RgbaFrame,
		tree: &LayoutBoxTree,
		ground: RgbaColor,
	) -> Self {
		let metrics = compute_metrics(tree, &frame, ground);
		Self { label: label.into(), frame, metrics: Some(metrics) }
	}

	/// Populates the cell's clutter metrics from the given layout box tree and
	/// ground colour.
	pub fn with_layout(mut self, tree: &LayoutBoxTree, ground: RgbaColor) -> Self {
		self.metrics = Some(compute_metrics(tree, &self.frame, ground));
		self
	}

	/// The caption's second line: the six metrics, or a note that the scene
	/// supplied no layout tree to measure.
	fn measurement_line(&self) -> String {
		match &self.metrics {
			Some(m) => format!(
				"gaps {}  sizes {}  edges {:.2}  ink {:.3}  density {:.2}  residue {:.3}",
				m.distinct_gaps,
				m.distinct_text_sizes,
				m.edge_count,
				m.ink_ratio,
				m.element_density,
				m.alignment_residue,
			),
			None => "no layout tree supplied, so the six metrics are not computed".to_string(),
		}
	}

	fn geometry_line(&self) -> String {
		format!(
			"{}x{} device  {:.0}x{:.0} logical  {}x",
			self.frame.width(),
			self.frame.height(),
			self.frame.logical_width(),
			self.frame.logical_height(),
			self.frame.scale_factor(),
		)
	}
}

/// Converts a frame into the image gpui paints.
///
/// `RenderImage` holds BGRA, in an `Rgba` container. The channel order is
/// swapped here rather than at the render boundary because a frame is RGBA
/// everywhere else in this crate, including in the PNGs and in every metric.
fn as_render_image(frame: &RgbaFrame) -> Arc<RenderImage> {
	let mut bgra = Vec::with_capacity(frame.as_bytes().len());
	for pixel in frame.as_bytes().as_chunks::<4>().0 {
		let [r, g, b, a] = pixel;
		bgra.extend_from_slice(&[*b, *g, *r, *a]);
	}

	// The buffer is exactly width * height * 4 because `RgbaFrame` rejects any
	// other length at construction, so this cannot be None in practice; the
	// fallback is a 1x1 transparent image rather than a panic.
	let buffer = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(frame.width(), frame.height(), bgra)
		.unwrap_or_else(|| ImageBuffer::from_pixel(1, 1, Rgba([0, 0, 0, 0])));

	Arc::new(RenderImage::new(SmallVec::from_elem(image::Frame::new(buffer), 1)))
}

/// How the cells are arranged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SheetGrid {
	pub columns: u32,
}

impl SheetGrid {
	pub const fn new(columns: u32) -> Self {
		Self { columns }
	}

	/// Rows needed for `count` cells, rounding up.
	pub const fn rows_for(&self, count: u32) -> u32 {
		if self.columns == 0 {
			return count;
		}
		count.div_ceil(self.columns)
	}
}

/// The sheet scene: a grid of bordered cells, each captioned.
struct Sheet {
	cells:      Vec<SheetCellView>,
	grid:       SheetGrid,
	cell_width: f32,
}

struct SheetCellView {
	label:       String,
	geometry:    String,
	measurement: String,
	image:       Arc<RenderImage>,
	width:       f32,
	height:      f32,
}

impl Render for Sheet {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let mut rows = Vec::new();
		let columns = self.grid.columns.max(1) as usize;

		for chunk in self.cells.chunks(columns) {
			let mut row = div().flex().flex_row().gap(px(CELL_GAP));
			for cell in chunk {
				row = row.child(
					div()
						.flex()
						.flex_col()
						.w(px(self.cell_width))
						.child(
							// The border sits outside the frame so the cell's
							// pixels are the scene's own, unclipped.
							div()
								.border(px(CELL_BORDER))
								.border_color(rgb(CELL_EDGE))
								.child(
									img(ImageSource::Render(Arc::clone(&cell.image)))
										.w(px(cell.width))
										.h(px(cell.height)),
								),
						)
						.child(
							div()
								.h(px(CAPTION_HEIGHT))
								.pt(px(CAPTION_PAD_TOP))
								.flex()
								.flex_col()
								.gap(px(CAPTION_LINE_GAP))
								.child(
									div()
										.text_size(px(CAPTION_LABEL_SIZE))
										.text_color(rgb(CAPTION_INK))
										.child(cell.label.clone()),
								)
								.child(
									div()
										.text_size(px(CAPTION_DETAIL_SIZE))
										.text_color(rgb(CAPTION_DIM))
										.child(cell.geometry.clone()),
								)
								.child(
									div()
										.text_size(px(CAPTION_DETAIL_SIZE))
										.text_color(rgb(CAPTION_DIM))
										.child(cell.measurement.clone()),
								),
						),
				);
			}
			rows.push(row);
		}

		div()
			.size_full()
			.bg(rgb(SHEET_GROUND))
			.p(px(SHEET_PADDING))
			.flex()
			.flex_col()
			.gap(px(CELL_GAP))
			.children(rows)
	}
}

/// Tiles cells into one sheet and returns the rendered frame.
///
/// Cells are laid out at their logical size, so a sheet of 2x frames is not
/// twice as wide as a sheet of 1x frames of the same surface.
pub fn tile(
	cx: &mut veyyon_gpui::HeadlessAppContext,
	cells: Vec<SheetCell>,
	grid: SheetGrid,
	scale_factor: f32,
) -> Result<RgbaFrame, RenderError> {
	if cells.is_empty() {
		return Err(RenderError::EmptySheet);
	}

	let cell_logical_width = cells
		.iter()
		.map(|cell| cell.frame.logical_width())
		.fold(0.0_f32, f32::max);
	let cell_logical_height = cells
		.iter()
		.map(|cell| cell.frame.logical_height())
		.fold(0.0_f32, f32::max);

	let views: Vec<SheetCellView> = cells
		.iter()
		.map(|cell| SheetCellView {
			label:       cell.label.clone(),
			geometry:    cell.geometry_line(),
			measurement: cell.measurement_line(),
			image:       as_render_image(&cell.frame),
			width:       cell.frame.logical_width(),
			height:      cell.frame.logical_height(),
		})
		.collect();

	let columns = grid.columns.max(1);
	let rows = grid.rows_for(views.len() as u32);

	// Each pitch is one cell plus its chrome, multiplied by an integer column or
	// row count, so the sheet size does not drift with the cell count.
	let cell_pitch_w = CELL_BORDER.mul_add(2.0, cell_logical_width) + CELL_GAP;
	let cell_pitch_h = CELL_BORDER.mul_add(2.0, cell_logical_height) + CAPTION_HEIGHT + CELL_GAP;
	let sheet_width = cell_pitch_w.mul_add(columns as f32, SHEET_PADDING * 2.0) - CELL_GAP;
	let sheet_height = cell_pitch_h.mul_add(rows as f32, SHEET_PADDING * 2.0) - CELL_GAP;

	let options = RenderOptions {
		width: sheet_width.ceil().max(1.0) as u32,
		height: sheet_height.ceil().max(1.0) as u32,
		scale_factor,
		..RenderOptions::default()
	};

	let cell_width = cell_logical_width;
	render_view(cx, &options, move |_window, app: &mut App| {
		app.new(move |_| Sheet { cells: views, grid: SheetGrid::new(columns), cell_width })
	})
}
