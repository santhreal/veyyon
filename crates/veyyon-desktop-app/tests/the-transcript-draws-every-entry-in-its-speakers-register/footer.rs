//! The model a finished turn is footed by opens the usage tab: clicking it
//! dispatches the `ShowPanelTab` the right panel opens its usage tab on, and
//! clicking the turn's words dispatches none.
//!
//! WHY: the footer is where a turn states which model ran it, and the usage
//! tab is where the session's accounting is drawn. A footer drawn without its
//! click, or one naming a tab the panel does not have, leaves the accounting
//! unreachable from the turn that spent it. The panel suite proves the action
//! opens the usage tab and draws the accounting; this proves the footer sends
//! it, for the tab by the name the panel states for it.
//!
//! Gap: the window holds the thread alone, so the tab the action opens is not
//! drawn here; the action is read off an app-wide listener.

use std::{cell::RefCell, rc::Rc};

use gpui::TestAppContext;
use veyyon_desktop_app::{actions::workspace::ShowPanelTab, panel::PanelTab};
use veyyon_desktop_model::MessageRole;

use super::{entry, items::click_run, opened, text, thread, turns::named};

#[gpui::test]
fn the_model_a_turn_is_footed_by_opens_the_usage_tab_and_its_words_open_nothing(
	cx: &mut TestAppContext,
) {
	let shown = Rc::new(RefCell::new(Vec::<String>::new()));
	let seen = Rc::clone(&shown);
	cx.update(|cx| {
		cx.on_action(move |action: &ShowPanelTab, _| seen.borrow_mut().push(action.tab.to_string()));
	});
	let mut thread = thread(
		cx,
		opened(vec![
			entry("u1", None, MessageRole::User, vec![text("do it")]),
			named(
				entry("a1", Some("u1"), MessageRole::Assistant, vec![text("done")]),
				"claude-opus-4-1",
			),
			entry("u2", Some("a1"), MessageRole::User, vec![text("again")]),
		]),
	);
	click_run(&mut thread, "done");
	assert_eq!(*shown.borrow(), Vec::<String>::new(), "the turn's words open no tab");
	click_run(&mut thread, "claude-opus-4-1");
	assert_eq!(
		*shown.borrow(),
		vec![PanelTab::Usage.name().to_owned()],
		"the footer opens the usage tab, once per click"
	);
}
