//! A document draws in a window: every block kind renders, a code block's
//! copy slot receives its code, a link opens its URL on click, and a style
//! with deferred highlighting never parses code while drawing.

use std::{cell::RefCell, rc::Rc};

use veyyon_desktop_ui::{
	markdown::{self, MarkdownDoc, MarkdownStyle},
	theme::{Appearance, Theme},
};
use veyyon_gpui::{
	Context, IntoElement, Modifiers, Render, TestAppContext, Window, div, point, prelude::*, px,
};

struct Harness {
	doc:   MarkdownDoc,
	style: MarkdownStyle,
}

impl Render for Harness {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		div().size_full().child(markdown::render(&self.doc, &self.style, window, cx))
	}
}

fn themed() -> TestAppContext {
	let cx = TestAppContext::single();
	cx.update(|cx| Theme::install(Appearance::Dark, cx)).expect("the dark palette parses");
	cx
}

#[test]
fn every_block_kind_renders_and_an_unknown_fence_draws_its_code_plain() {
	let mut cx = themed();
	let copied = Rc::new(RefCell::new(Vec::<String>::new()));
	let sink = Rc::clone(&copied);
	let style = MarkdownStyle::new("doc").copy_button(move |code, _, _| {
		sink.borrow_mut().push(code.to_string());
		div().into_any_element()
	});
	let doc = MarkdownDoc::new(
		"# Title\n\n```klingon\nqapla' batlh\n```\n\n1. one\n   - [x] done\n\n> quoted **text**\n\n\
		 | a | b |\n|---|--:|\n| 1 | 2 |\n\n---\n\n`inline` ~~gone~~ [link](https://example.com)\n",
	);
	let (_, window) = cx.add_window_view(move |_, _| Harness { doc, style });
	window.run_until_parked();
	let copied = copied.borrow();
	assert!(!copied.is_empty(), "the code block drew its header");
	assert!(copied.iter().all(|code| code == "qapla' batlh"), "{copied:?}");
}

#[test]
fn clicking_a_link_opens_its_url() {
	let mut cx = themed();
	let doc = MarkdownDoc::new("[documentation link](https://example.com/docs)");
	let (_, window) =
		cx.add_window_view(move |_, _| Harness { doc, style: MarkdownStyle::new("doc") });
	window.run_until_parked();
	window.simulate_click(point(px(6.0), px(8.0)), Modifiers::none());
	window.run_until_parked();
	assert_eq!(cx.opened_url().as_deref(), Some("https://example.com/docs"));
}

/// Draws one Rust fence holding `code` with `style` and reports whether the
/// highlight cache holds a result for that code afterwards.
fn cache_holds_code_after_drawing(code: &str, style: MarkdownStyle) -> bool {
	let mut cx = themed();
	let doc = MarkdownDoc::new(format!("```rust\n{code}\n```\n"));
	let (_, window) = cx.add_window_view(move |_, _| Harness { doc, style });
	window.run_until_parked();
	markdown::cached(code, Some("rust")).is_some()
}

#[test]
fn a_deferred_style_draws_without_highlighting_and_the_default_style_highlights() {
	let deferred = "fn deferred_only() -> u8 { 7 }";
	assert!(
		!cache_holds_code_after_drawing(deferred, MarkdownStyle::new("doc").deferred_highlight()),
		"drawing with deferred highlighting parsed the code"
	);
	let eager = "fn eager_only() -> u8 { 8 }";
	assert!(cache_holds_code_after_drawing(eager, MarkdownStyle::new("doc")));
}
