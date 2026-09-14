//! WHY: `ClipboardItem::text()` converts `ExternalPaths` into path strings.
//! Pasting files must emit the original typed item, not insert those strings
//! into a draft. Mixed offers must retain media before their textual
//! representation. This suite drives real editor key dispatch; native MIME
//! negotiation is tested in GPUI.

mod common;

use std::{path::PathBuf, sync::Arc};

use parking_lot::Mutex;
use veyyon_desktop_kit::input::EditorEvent;
use veyyon_gpui::{
	Bounds, ClipboardEntry, ClipboardItem, ExternalPaths, Image, ImageFormat, point, px, size,
};

#[test]
fn typed_clipboard_entries_take_precedence_over_text_without_changing_the_draft() {
	let (mut cx, _permit, window, editor) = common::setup_editor_window(
		Bounds::new(point(px(0.0), px(0.0)), size(px(600.0), px(300.0))),
		5,
	);
	let events = Arc::new(Mutex::new(Vec::new()));
	let observed = Arc::clone(&events);
	cx.update(|app| {
		app.subscribe(&editor, move |_, event: &EditorEvent, _| {
			observed.lock().push(event.clone());
		})
		.detach();
	});
	let entries = [
		ClipboardEntry::ExternalPaths(ExternalPaths(smallvec::smallvec![
			PathBuf::from("/workspace/project notes.txt"), PathBuf::from("/workspace/image.svg"),
		])),
		ClipboardEntry::Image(Image {
			id: 1, format: ImageFormat::Svg,
			bytes: br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>"#.to_vec(),
		}),
	];
	for entry in entries {
		for with_text in [false, true] {
			let mut item = ClipboardItem { entries: vec![entry.clone()] };
			if with_text {
				item
					.entries
					.insert(0, ClipboardEntry::from("file manager label".to_string()));
			}
			cx.update(|app| {
				editor.update(app, |editor, cx| editor.set_text("retained draft", cx));
				app.write_to_clipboard(item.clone());
			});
			common::render_frame(&mut cx, &window);
			events.lock().clear();
			common::dispatch_keystroke(&mut cx, &window, "cmd-v");
			assert_eq!(cx.update(|app| editor.read(app).text().to_owned()), "retained draft");
			assert_eq!(*events.lock(), vec![EditorEvent::PasteMedia(item)]);
		}
	}
}

#[test]
fn empty_clipboard_is_inert_and_plain_text_keeps_multiline_normalization() {
	let (mut cx, _permit, window, editor) = common::setup_editor_window(
		Bounds::new(point(px(0.0), px(0.0)), size(px(600.0), px(300.0))),
		5,
	);
	for (item, expected) in [
		(ClipboardItem { entries: Vec::new() }, ""),
		(ClipboardItem::new_string("first\r\nsecond".into()), "first\nsecond"),
	] {
		cx.update(|app| {
			editor.update(app, |editor, cx| editor.set_text("", cx));
			app.write_to_clipboard(item);
		});
		common::render_frame(&mut cx, &window);
		common::dispatch_keystroke(&mut cx, &window, "cmd-v");
		assert_eq!(cx.update(|app| editor.read(app).text().to_owned()), expected);
	}
}
