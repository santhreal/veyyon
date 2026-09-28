//! The drawer's tab strip: a label per tab, a close button on each terminal,
//! and the driver target each tab is found under.

use std::{collections::HashMap, rc::Rc};

use veyyon_desktop_ui::overlays::{Tab, TabWrapper};

use super::{DrawerTab, Screen, tabs};
use crate::{AppState, driver};

/// The strip's tabs, in strip order: a terminal is titled as its program
/// last set it and closes from the strip.
pub(super) fn tab_items(
	app: &AppState,
	strip: &[DrawerTab],
	screens: &HashMap<DrawerTab, Screen>,
) -> Vec<Tab> {
	strip
		.iter()
		.map(|tab| {
			let title = screens.get(tab).map_or("", Screen::title);
			Tab::new(tabs::label(app, tab, title)).closable(matches!(tab, DrawerTab::Terminal(_)))
		})
		.collect()
}

/// Registers each tab of `strip` as the `drawer.tab:<slug>` target.
pub(super) fn tab_wrapper(strip: &[DrawerTab]) -> TabWrapper {
	let slugs: Vec<String> = strip.iter().map(DrawerTab::slug).collect();
	Rc::new(move |ix, element| match slugs.get(ix) {
		Some(slug) => driver::target(("drawer.tab", slug.clone()), element),
		None => element,
	})
}
