//! WHY: a settings row hands its control column to a field that is one
//! control tall, and the editor inside it wraps what it holds to as many
//! lines as the text needs. A placeholder longer than the column wrapped to
//! two lines and the editor painted both: the second line landed under the
//! field's own edge, inside the row's band, so the Background task row on the
//! Extensions page read as a field with a severed line of grey under it.
//!
//! CLASS CLOSED: any field whose content is taller than the field, in the
//! shape the page draws it in -- a field sharing its column with a button, so
//! the column is narrower than the text. The two arms differ only in how long
//! the placeholder is, and a wrapped one may ink no row a short one does not:
//! a second line, a clipped sliver of one, or a descender pushed past the
//! edge all change the rows the column inks. Nothing here names the band, so
//! the assertion holds at any control size and any type ramp.
//!
//! NOT CAUGHT: which line survives the cut when the caret is on a later one,
//! and whether the text should have been given a wider column instead. The
//! row's own band is measured in
//! `a-row-clips-a-control-taller-than-the-band-it-declares`.

use std::path::Path;

use veyyon_desktop_kit::{
	Button, ButtonSize, Row, SpacingStep,
	input::{Editor, EditorMode, TextField},
	load_bundled_theme, load_bundled_tokens,
};
use veyyon_desktop_scene::{
	frame::RgbaColor,
	headless::{Captured, RenderOptions, headless_context, render_view_captured},
};
use veyyon_desktop_surface::{
	InstalledTokens, controls::Availability, install_tokens, settings::setting_row,
};
use veyyon_gpui::{
	App, AppContext, Bounds, Context, Entity, IntoElement, ParentElement, Pixels, Render, Styled,
	Window, div, px,
};

/// The placeholder the Background task row asks for, which is longer than the
/// column the row leaves once the Run button has taken its width.
const LONG_PLACEHOLDER: &str = "Describe a task to run in the background";
/// A placeholder that fits on one line, carrying an ascender and a descender
/// so its ink reaches as far up and down the line as the long one's does.
const SHORT_PLACEHOLDER: &str = "Type jobs";
const ROW_WIDTH: f32 = 720.0;
const ROW_HEIGHT: f32 = 120.0;

/// The Background task row's shape: a field and the button that runs it,
/// sharing the row's control column.
struct FieldRow {
	installed: InstalledTokens,
	editor:    Entity<Editor>,
}

impl Render for FieldRow {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let tokens = self.installed.set.clone();
		let geometry = self.installed.surface.settings.clone();
		div().w(px(ROW_WIDTH)).flex().flex_col().child(setting_row(
			"Background task",
			Some("Runs as a subagent of the active session"),
			Row::new(SpacingStep::S2)
				.child(TextField::new("task-field", self.editor.clone()))
				.child(Button::new("task-run", "Run").size(ButtonSize::Small)),
			&Availability::Enabled,
			&geometry,
			&tokens,
		))
	}
}

/// The row rendered offscreen with a field holding `placeholder`, and the
/// width of the control column the field was drawn in.
fn field_row(placeholder: &'static str) -> (Captured, f32) {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let mut cx = headless_context().expect("a headless renderer is required to draw the field");
	let options = RenderOptions {
		width: ROW_WIDTH as u32,
		height: ROW_HEIGHT as u32,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let mut column_width = 0.0_f32;
	let captured = render_view_captured(&mut cx, &options, |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		column_width = installed.surface.settings.control_column_width_px;
		let editor = app.new(|cx| {
			Editor::new(EditorMode::Multiline { newline_on_enter: false }, cx)
				.placeholder(placeholder)
				.max_visible_lines(1)
		});
		app.new(|_| FieldRow { installed, editor })
	})
	.expect("the row renders offscreen");
	(captured, column_width)
}

/// Whether `pixel` differs from `ground` by more than sampling noise.
fn is_ink(pixel: RgbaColor, ground: RgbaColor) -> bool {
	let delta = |left: u8, right: u8| i32::from(left).abs_diff(i32::from(right));
	delta(pixel.r, ground.r) > 6 || delta(pixel.g, ground.g) > 6 || delta(pixel.b, ground.b) > 6
}

/// The box the field draws in: the widest hit rect in the control column,
/// since the field takes the column's width and every other control in it --
/// the button beside it, the editor inside it -- takes less.
fn field_box(captured: &Captured, column_width: f32) -> Bounds<Pixels> {
	let column_left = ROW_WIDTH - column_width;
	*captured
		.hitboxes
		.iter()
		.filter(|rect| f32::from(rect.left()) >= column_left)
		.max_by(|left, right| {
			f32::from(left.size.width)
				.partial_cmp(&f32::from(right.size.width))
				.expect("a width is a real number")
		})
		.expect("the field registers a hit rect in the control column")
}

/// Every row of the field's interior holding ink, as logical y positions top
/// down. The interior is inset past the rounded edge, so what is measured is
/// the text the field draws rather than the box around it.
fn inked_rows(captured: &Captured, field: Bounds<Pixels>) -> Vec<f32> {
	let frame = &captured.frame;
	let scale = frame.scale_factor();
	let ground = frame
		.pixel(frame.width() / 2, 1)
		.expect("the row draws on a ground");
	let device = |value: f32| (value * scale).round().max(0.0) as u32;
	let x0 = device(f32::from(field.left()) + EDGE_INSET);
	let x1 = device(f32::from(field.right()) - EDGE_INSET).min(frame.width());
	let y0 = device(f32::from(field.top()) + 1.0);
	let y1 = device(f32::from(field.bottom()) - 1.0).min(frame.height());
	(y0..y1)
		.filter(|y| {
			(x0..x1).any(|x| {
				frame
					.pixel(x, *y)
					.is_some_and(|pixel| is_ink(pixel, ground))
			})
		})
		.map(|y| y as f32 / scale)
		.collect()
}

/// How far past the field's edge the interior starts, which is wider than the
/// corner radius so a rounded edge is not read as text.
const EDGE_INSET: f32 = 14.0;

#[test]
fn a_field_draws_one_line_of_what_it_holds() {
	let (short_frame, column_width) = field_row(SHORT_PLACEHOLDER);
	let (long_frame, _) = field_row(LONG_PLACEHOLDER);
	let short = inked_rows(&short_frame, field_box(&short_frame, column_width));
	let long = inked_rows(&long_frame, field_box(&long_frame, column_width));

	// The field is not blank, so neither arm can agree with the other by
	// drawing nothing at all.
	assert!(
		short.len() >= 4,
		"a field holding {SHORT_PLACEHOLDER:?} inked {} rows, which is not a drawn line of text",
		short.len()
	);

	let span = |rows: &[f32]| match (rows.first(), rows.last()) {
		(Some(first), Some(last)) => last - first,
		_ => 0.0,
	};
	let (short_span, long_span) = (span(&short), span(&long));
	assert!(
		long_span <= short_span + 1.0,
		"a placeholder that wraps inked a {long_span}px band of the field where one that fits inked \
		 {short_span}px: the lines past the first are drawn in the field rather than cut at its edge"
	);
}
