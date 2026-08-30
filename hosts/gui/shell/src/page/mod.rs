//! One page per route.
//!
//! [`page`] matches [`Route`] with no wildcard arm. A route added to the
//! contract stops this file compiling, which is the point: a route that renders
//! as nothing is a screen an operator can open and find blank.
//!
//! A page draws a screen the operator navigates. What a tool result looks like
//! inside the transcript is `veyyon-gui-views`, and where the two would overlap
//! the view kind wins: [`report`] draws its sections through
//! `veyyon_gui_views::view`, and [`diff`] is that crate's diff renderer with a
//! heading around it, not a second one.

pub mod board;
pub mod diff;
pub mod form;
pub mod pick;
pub mod report;
pub mod splash;
pub mod tree;
pub mod wizard;

use gpui::{AnyElement, App, Div, IntoElement, ParentElement, Styled};
use veyyon_gui_contract::screen::Route;
use veyyon_gui_kit::{
	Level,
	chrome::column,
	surface,
	text::title,
	tokens::{layout, radius, space},
};

/// The routed page as an element, or `None` for the transcript route, which the
/// window draws itself.
pub fn page(route: &Route, cx: &App) -> Option<AnyElement> {
	let body = match route {
		Route::Session => return None,
		Route::Pick(value) => pick::pick(value, cx).into_any_element(),
		Route::Form(value) => form::form(value, cx).into_any_element(),
		Route::Board(value) => board::board(value, cx).into_any_element(),
		Route::Report(value) => report::report(value, cx).into_any_element(),
		Route::Tree(value) => tree::tree(value, cx).into_any_element(),
		Route::Splash(value) => splash::splash(value, cx).into_any_element(),
		Route::Wizard(value) => wizard::wizard(value, cx).into_any_element(),
		Route::Diff(value) => diff::diff(value, cx).into_any_element(),
	};
	Some(sheet(route, body, cx).into_any_element())
}

/// The panel a page is drawn on.
///
/// One sheet for every page, so a screen cannot arrive with a different corner,
/// a different inset or a different width from the rest. A splash fills the
/// window instead, because a full-window statement inside a bounded sheet reads
/// as a dialog.
fn sheet(route: &Route, body: impl IntoElement, cx: &App) -> Div {
	if matches!(route, Route::Splash(_)) {
		return surface(Level::Window, cx)
			.size_full()
			.flex()
			.flex_col()
			.child(body);
	}
	surface(Level::Overlay, cx)
		.w(layout::DIALOG)
		.max_h_full()
		.p(space::BASE)
		.rounded(radius::LARGE)
		.flex()
		.flex_col()
		.gap(space::BASE)
		.child(column(space::TIGHT).child(title(page_title(route), cx)))
		.child(body)
}

/// What a page's heading says.
///
/// The same match [`page`] performs, reduced to data. A gpui element cannot be
/// inspected, so this is what a sweep over `RouteId::ALL` asserts: a route
/// whose title comes from its payload is a route whose payload the drawing
/// reaches.
pub fn page_title(route: &Route) -> String {
	match route {
		Route::Session => "Session".to_owned(),
		Route::Pick(value) => value.title.clone(),
		Route::Form(value) => value.title.clone(),
		Route::Board(value) => value.title.clone(),
		Route::Report(value) => value.title.clone(),
		Route::Tree(value) => value.title.clone(),
		Route::Splash(value) => value.headline.clone(),
		Route::Wizard(value) => value.title.clone(),
		Route::Diff(value) => value.title.clone(),
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The dispatcher is exhaustive, so a route cannot be forgotten at the
	//! match. What the compiler does not cover is an arm that reaches a payload
	//! it never reads: an arm returning a heading built from a literal draws a
	//! screen with the wrong title and looks deliberate. [`page_title`] performs
	//! the same match over the same payloads, so a route that cannot name itself
	//! from its own data does not draw it either.
	//!
	//! It also pins that the transcript route draws no page. A page over the
	//! transcript that is the transcript would mount it twice, and the second
	//! copy would take the scroll.
	//!
	//! WHAT IT DOES NOT CATCH. Appearance. Whether a page is laid out, coloured
	//! or sized correctly needs a window, and the capture of every route covers
	//! it.

	use veyyon_gui_contract::{fixtures, screen::RouteId};

	use super::*;

	#[test]
	fn every_route_names_itself_from_its_own_data() {
		for id in RouteId::ALL {
			let route = fixtures::route(id);
			let heading = page_title(&route);
			assert!(!heading.is_empty(), "{} drew an empty heading", id.key());
			assert_eq!(route.id(), id, "the fixture for {} is another route", id.key());
		}
	}

	#[test]
	fn no_two_routes_share_a_heading() {
		let mut headings: Vec<String> = RouteId::ALL
			.into_iter()
			.map(|id| page_title(&fixtures::route(id)))
			.collect();
		let count = headings.len();
		headings.sort();
		headings.dedup();
		assert_eq!(headings.len(), count, "two routes drew the same heading");
	}

	#[test]
	fn a_heading_reads_the_payload_rather_than_the_route_name() {
		let one = Route::Pick(fixtures::routes::model_picker());
		let other = Route::Pick(veyyon_gui_contract::screen::PickList::new("Theme", Vec::new()));
		assert_ne!(page_title(&one), page_title(&other), "the heading ignored its payload");
	}
}
