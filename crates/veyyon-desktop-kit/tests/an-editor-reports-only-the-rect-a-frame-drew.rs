//! WHY: A test and a caller aim a pointer at `Editor::drawn_bounds()` to land
//! on the text an editor drew rather than on the padding of the field around
//! it. A rect reported before any frame drew one, or a rect held over from an
//! earlier frame, sends that pointer somewhere the text is not, and every
//! assertion made through it then passes against a click that never landed in
//! the field.
//!
//! THE CLASS THIS CLOSES: `drawn_bounds()` answering with anything other than
//! the rect of the last frame that laid the editor out. Three states are
//! asserted: an editor no element has laid out has no rect at all, a drawn one
//! reports where its parent put it rather than the window origin, and after
//! the parent moves the rect moves with it instead of standing on the previous
//! frame's numbers. Opening a window paints it, so "before the first frame" is
//! reachable only through a retained editor no row has drawn yet, which is the
//! state §8.25's field registry holds.
//!
//! WHAT IT DOES NOT CATCH: the rect's use by a hit test lives in the surfaces,
//! where `a-setting-row-sends-the-value-its-field-holds` clicks through it. A
//! rect correct in logical pixels but wrong under a scale factor other than
//! 1.0 is not covered here.

mod common;

use common::{headless_context, render_frame};
use veyyon_desktop_kit::{
	TokenSet,
	input::{Editor, EditorMode},
};
use veyyon_gpui::{
	AppContext, Context, Entity, IntoElement, ParentElement, Pixels, Render, Styled, Window, div,
	px, size,
};

/// The editor inside a parent that pads it away from the window origin, so a
/// rect measured from the window rather than from the element is a different
/// number.
struct PaddedParent {
	editor: Entity<Editor>,
	pad_x:  Pixels,
	pad_y:  Pixels,
}

impl Render for PaddedParent {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div()
			.size_full()
			.pl(self.pad_x)
			.pt(self.pad_y)
			.child(self.editor.clone())
	}
}

#[test]
fn an_editor_reports_the_rect_a_frame_laid_out_and_nothing_for_one_no_frame_did() {
	let (mut cx, _permit) = headless_context();
	let first_pad = (px(30.0), px(20.0));
	let second_pad = (px(90.0), px(60.0));

	let mut editor_slot = None;
	let mut parent_slot = None;
	let mut retained_slot = None;
	let window = cx
		.open_window(size(px(500.0), px(300.0)), |_window, app| {
			app.set_global(TokenSet::default());
			let editor = app.new(|cx| Editor::new(EditorMode::SingleLine, cx));
			editor_slot = Some(editor.clone());
			// A retained field the surface holds for a row it has not drawn
			// yet: §8.25 keeps these across frames, so one exists before any
			// element of it is laid out.
			retained_slot = Some(app.new(|cx| Editor::new(EditorMode::SingleLine, cx)));
			let parent =
				app.new(|_cx| PaddedParent { editor, pad_x: first_pad.0, pad_y: first_pad.1 });
			parent_slot = Some(parent.clone());
			parent
		})
		.expect("headless window opens");
	let editor = editor_slot.expect("the editor entity is held");
	let parent = parent_slot.expect("the parent entity is held");
	let retained = retained_slot.expect("the retained editor is held");

	render_frame(&mut cx, &window);
	let drawn = cx
		.update(|app| editor.read(app).drawn_bounds())
		.expect("a drawn editor reports the rect it drew");
	assert_eq!(
		(drawn.origin.x, drawn.origin.y),
		first_pad,
		"the rect starts where the parent placed the editor, not at the window origin"
	);
	assert!(
		drawn.size.width > px(0.0) && drawn.size.height > px(0.0),
		"the drawn rect has an area a pointer can land in; got {:?}",
		drawn.size
	);

	cx.update(|app| {
		parent.update(app, |parent, cx| {
			parent.pad_x = second_pad.0;
			parent.pad_y = second_pad.1;
			cx.notify();
		});
	});
	render_frame(&mut cx, &window);
	let moved = cx
		.update(|app| editor.read(app).drawn_bounds())
		.expect("the moved editor reports a rect");
	assert_eq!(
		(moved.origin.x, moved.origin.y),
		second_pad,
		"the rect follows the frame that moved the editor rather than standing on the previous \
		 frame's numbers"
	);

	let never_drawn = cx.update(|app| retained.read(app).drawn_bounds());
	assert!(
		never_drawn.is_none(),
		"a retained editor no element has laid out reports no rect, so a caller can tell an undrawn \
		 field from one drawn at the window origin; got {never_drawn:?}"
	);
}
