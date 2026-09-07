//! WHY THIS TEST EXISTS:
//! `scene render '*' --contact-sheet` is how the catalogue is reviewed, and it
//! produced no sheet at all: 238 scenes at the command's default 1180x800 and
//! six columns ask the renderer for a 7212x34584 texture and a gigabyte of
//! readback, which came back as `BufferAsyncError` after every cell had been
//! rendered. The whole review surface was unreachable, and the failure named
//! neither a size nor a knob.
//!
//! THE CLASS THIS CLOSES: a sheet whose size is decided by how many cells were
//! passed rather than by what the device can carry. The bound is asserted on the
//! real catalogue's size at the real default frame, the split is asserted to
//! keep whole rows so two pages stay comparable, and `tile` is asserted to
//! refuse an over-limit sheet by naming the size and the column count instead of
//! attempting it. A future frame size, column default or scene count that
//! overruns the bound turns the paging arithmetic red here rather than in a
//! renderer error.
//!
//! WHAT IT DOES NOT CATCH: the device's true `maxImageDimension2D` or its free
//! memory, neither of which is knowable here; `MAX_SHEET_EDGE_PX` is a fixed
//! bound below every driver in use, not a query. It also does not judge the
//! sheet's contents - `a_twelve_candidate_sweep_tiles_into_one_sheet` owns that.

use veyyon_desktop_scene::{
	MAX_SHEET_EDGE_PX, RenderError, RgbaColor, RgbaFrame, SceneRegistry, SheetCell, SheetGrid,
	headless_context, page, rows_per_sheet, sheet_device_size, tile,
};

/// The defaults `veyyon-desktop scene render` renders at, from `cli.rs`.
const DEFAULT_WIDTH: f32 = 1180.0;
const DEFAULT_HEIGHT: f32 = 800.0;
const DEFAULT_COLUMNS: u32 = 4;

/// Small enough that a few hundred fit in a test's memory, and the paging
/// arithmetic is the same at any cell size.
const CELL_W: u32 = 60;
const CELL_H: u32 = 40;

fn cells(count: usize) -> Vec<SheetCell> {
	(0..count)
		.map(|index| {
			let frame = RgbaFrame::filled(CELL_W, CELL_H, 1.0, RgbaColor::new(20, 20, 26, 255))
				.expect("a filled frame of a valid size");
			SheetCell::new(format!("cell/{index:03}"), frame)
		})
		.collect()
}

#[test]
fn the_whole_catalogue_at_the_command_defaults_pages_within_the_bound() {
	let scenes = SceneRegistry::new().iter().count();
	assert!(scenes > 0, "the catalogue must register scenes");

	let grid = SheetGrid::new(DEFAULT_COLUMNS);
	let all_rows = grid.rows_for(scenes as u32);
	let (unpaged_w, unpaged_h) =
		sheet_device_size(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_COLUMNS, all_rows, 1.0);
	assert!(
		unpaged_h > MAX_SHEET_EDGE_PX,
		"{scenes} scenes in one sheet is {unpaged_w}x{unpaged_h}, which no longer overruns \
		 {MAX_SHEET_EDGE_PX}; the paging this suite guards is dead code"
	);

	let rows = rows_per_sheet(DEFAULT_HEIGHT, 1.0);
	assert!(rows >= 1, "a sheet holds at least one row");
	let pages = all_rows.div_ceil(rows);
	assert!(pages > 1, "the catalogue must page");
	for page_index in 0..pages {
		let page_rows = rows.min(all_rows - page_index * rows);
		let (width, height) =
			sheet_device_size(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_COLUMNS, page_rows, 1.0);
		assert!(
			width <= MAX_SHEET_EDGE_PX && height <= MAX_SHEET_EDGE_PX,
			"page {page_index} is {width}x{height}, over {MAX_SHEET_EDGE_PX}"
		);
	}
}

#[test]
fn a_page_holds_whole_rows_so_two_pages_stay_comparable() {
	let grid = SheetGrid::new(3);
	let rows = rows_per_sheet(CELL_H as f32, 1.0);
	let per_page = rows as usize * 3;
	let total = per_page * 2 + 4;

	let pages = page(cells(total), grid, 1.0);
	assert_eq!(pages.len(), 3, "{total} cells at {per_page} per page");
	assert_eq!(pages[0].len(), per_page);
	assert_eq!(pages[1].len(), per_page);
	assert_eq!(pages[2].len(), 4, "the last page carries the remainder");

	// Column position is the cell's index within its page, so a cell must sit in
	// the column an unbounded sheet would have given it.
	let flat: Vec<&str> = pages
		.iter()
		.flatten()
		.map(|cell| cell.label.as_str())
		.collect();
	assert_eq!(flat.len(), total, "every cell reaches exactly one page");
	for (index, label) in flat.iter().enumerate() {
		assert_eq!(*label, format!("cell/{index:03}"), "order is preserved across pages");
	}
	assert!(
		pages.iter().all(|page| !page.is_empty()),
		"an empty page would render as a sheet of chrome"
	);
}

#[test]
fn a_sheet_that_fits_is_not_paged() {
	let pages = page(cells(4), SheetGrid::new(4), 1.0);
	assert_eq!(pages.len(), 1, "four small cells are one sheet");
	assert_eq!(pages[0].len(), 4);
}

#[test]
fn no_cells_are_no_pages() {
	assert!(page(Vec::new(), SheetGrid::new(4), 1.0).is_empty());
}

#[test]
fn the_bound_is_in_device_pixels_so_scale_halves_the_rows() {
	let at_1x = rows_per_sheet(DEFAULT_HEIGHT, 1.0);
	let at_2x = rows_per_sheet(DEFAULT_HEIGHT, 2.0);
	assert!(at_1x > at_2x, "a 2x sheet is twice the device pixels: {at_1x} vs {at_2x}");
	let (_, height) = sheet_device_size(DEFAULT_WIDTH, DEFAULT_HEIGHT, 1, at_2x, 2.0);
	assert!(height <= MAX_SHEET_EDGE_PX, "{height} device pixels at 2x");
}

#[test]
fn a_cell_taller_than_the_bound_gets_one_row_rather_than_no_page() {
	// The paging loop must terminate on a cell no sheet can hold; `tile` then
	// reports the overrun. A zero here would divide the cell count by zero, and
	// a loop that kept searching would hang the command.
	let rows = rows_per_sheet(f32::from(u16::MAX), 1.0);
	assert_eq!(rows, 1);

	let pages = page(cells(3), SheetGrid::new(1), 1.0);
	assert!(!pages.is_empty(), "a page is always produced");
}

#[test]
fn an_over_limit_sheet_is_refused_by_size_and_not_attempted() {
	let mut cx = headless_context().expect("a headless context");
	let tall = RgbaFrame::filled(64, 9000, 1.0, RgbaColor::new(20, 20, 26, 255))
		.expect("a tall frame");
	let error = tile(&mut cx, vec![SheetCell::new("tall/one", tall)], SheetGrid::new(2), 1.0)
		.expect_err("a 9000px cell overruns the bound");

	match error {
		RenderError::SheetTooLarge { width, height, limit, cells, columns } => {
			assert_eq!(limit, MAX_SHEET_EDGE_PX);
			assert_eq!(cells, 1);
			assert_eq!(columns, 2);
			assert!(height > limit, "{height} must be the overrun");
			assert!(width <= limit, "the width is not what overran: {width}");
		},
		other => panic!("expected a size refusal, got {other}"),
	}

	let message = format!(
		"{}",
		tile(
			&mut cx,
			vec![SheetCell::new(
				"tall/two",
				RgbaFrame::filled(64, 9000, 1.0, RgbaColor::new(20, 20, 26, 255))
					.expect("a tall frame")
			)],
			SheetGrid::new(2),
			1.0,
		)
		.expect_err("still refused")
	);
	assert!(message.contains("2 columns"), "the message names the knob: {message}");
	assert!(
		message.contains(&MAX_SHEET_EDGE_PX.to_string()),
		"the message names the limit: {message}"
	);
}
