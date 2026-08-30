//! Settings, in the main panel rather than in a dialog.
//!
//! A dialog would float over the conversation it is changing the look of, which
//! is the one thing a look setting has to be judged against. Here the sidebar,
//! the titlebar and the terminal strip stay on screen and change under the
//! pointer as a value is set.
//!
//! Every control on these pages is wired to a move over the store. A page that
//! shows a switch which changes nothing is worse than a page that does not show
//! it.

use gpui::{
	Context, Div, InteractiveElement, IntoElement, ParentElement, Stateful,
	StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};

use crate::{
	motion::{self, Channel, Key},
	shell::Shell,
	state::{
		agent,
		model::{Appearance, SettingsPage},
		moves,
	},
	theme::{Theme, layout, radius, size, space},
	ui,
};

pub fn render(shell: &mut Shell, page: SettingsPage, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let body = match page {
		SettingsPage::Appearance => appearance(shell, cx).into_any_element(),
		SettingsPage::Models => models(shell, cx).into_any_element(),
		SettingsPage::Shortcuts => shortcuts(cx).into_any_element(),
		SettingsPage::Agents => agents(shell, cx).into_any_element(),
	};

	div()
		.flex()
		.size_full()
		.min_h(px(0.0))
		.bg(theme.canvas)
		.child(nav(shell, page, cx))
		.child(ui::hairline_v(&theme))
		.child(
			div()
				.id("settings-body")
				.flex()
				.flex_col()
				.flex_1()
				.min_w(px(0.0))
				.overflow_y_scroll()
				.child(
					div()
						.flex()
						.flex_col()
						.gap(px(space::LOOSE))
						.w_full()
						.max_w(px(layout::READING))
						.px(px(space::HUGE))
						.py(px(space::HUGE))
						.child(
							div()
								.text_size(px(size::TITLE))
								.font_weight(gpui::FontWeight::SEMIBOLD)
								.child(page.label()),
						)
						.child(body),
				),
		)
}

/// The page list.
fn nav(shell: &mut Shell, current: SettingsPage, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let mut column = div()
		.flex()
		.flex_col()
		.gap(px(2.0))
		.w(px(196.0))
		.flex_none()
		.p(px(space::BASE))
		.bg(theme.panel);

	column = column.child(
		ui::eyebrow("Settings", &theme)
			.px(px(space::SNUG))
			.pb(px(space::SNUG)),
	);

	for page in SettingsPage::ALL {
		let selected = page == current;
		let key = Key::named(Channel::Row, page.label());
		let hover = shell.motion.value(key, now);
		let ground = if selected {
			theme.selected()
		} else {
			motion::mix(gpui::transparent_black(), theme.hover(), hover)
		};
		column = column.child(
			div()
				.id(page.label())
				.flex()
				.items_center()
				.h(px(30.0))
				.px(px(space::BASE))
				.rounded(px(radius::ROW))
				.bg(ground)
				.text_size(px(size::SMALL))
				.text_color(if selected {
					theme.text
				} else {
					theme.text_muted
				})
				.cursor_pointer()
				.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
					let now = shell.now;
					shell.motion.flip(key, *hovered, motion::WASH, now);
					window.refresh();
				}))
				.on_click(cx.listener(move |shell, _, _, cx| {
					moves::open_settings(&mut shell.store, page);
					cx.notify();
				}))
				.child(page.label()),
		);
	}

	column.child(ui::spacer()).child(
		div()
			.id("settings-close")
			.flex()
			.items_center()
			.h(px(30.0))
			.px(px(space::BASE))
			.rounded(px(radius::ROW))
			.text_size(px(size::SMALL))
			.text_color(theme.text_faint)
			.cursor_pointer()
			.on_click(cx.listener(|shell, _, _, cx| {
				moves::close_settings(&mut shell.store);
				cx.notify();
			}))
			.child("Back to session"),
	)
}

fn appearance(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let current = shell.store.settings.appearance;
	let font_size = shell.store.settings.font_size;
	let show_settled = shell.store.settings.show_settled;
	let grouped = shell.store.settings.group_by_folder;
	let sounds = shell.store.settings.sounds;
	let chosen = shell.store.settings.theme.clone();
	let themes = shell.store.themes.clone();

	let mut theme_rows = div().flex().flex_col().w_full();
	for (index, name) in themes.iter().enumerate() {
		let picked = *name == chosen;
		let name_owned = name.clone();
		theme_rows =
			theme_rows.child(pick_row(shell, "theme", index, name.clone(), picked, cx).on_click(
				cx.listener(move |shell, _, _, cx| {
					moves::set_theme(&mut shell.store, &name_owned);
					cx.notify();
				}),
			));
	}

	group(&theme, "How it reads")
		.child(
			field(&theme, "Appearance", "Dark grounds, or light ones.").child(
				ui::line_of(space::TIGHT)
					.child(segment(shell, "dark", "Dark", current == Appearance::Dark, cx).on_click(
						cx.listener(|shell, _, _, cx| {
							moves::set_appearance(&mut shell.store, Appearance::Dark);
							Theme::set(Appearance::Dark, cx);
							cx.notify();
						}),
					))
					.child(segment(shell, "light", "Light", current == Appearance::Light, cx).on_click(
						cx.listener(|shell, _, _, cx| {
							moves::set_appearance(&mut shell.store, Appearance::Light);
							Theme::set(Appearance::Light, cx);
							cx.notify();
						}),
					)),
			),
		)
		.child(
			field(&theme, "Text size", "Applies to the whole window.").child(
				ui::line_of(space::TIGHT)
					.child(step(shell, "font-down", "\u{2212}", cx).on_click(cx.listener(
						move |shell, _, _, cx| {
							let next = shell.store.settings.font_size - 1.0;
							moves::set_font_size(&mut shell.store, next);
							cx.notify();
						},
					)))
					.child(
						div()
							.w(px(34.0))
							.text_size(px(size::SMALL))
							.text_color(theme.text)
							.child(format!("{font_size:.0}")),
					)
					.child(step(shell, "font-up", "+", cx).on_click(cx.listener(
						move |shell, _, _, cx| {
							let next = shell.store.settings.font_size + 1.0;
							moves::set_font_size(&mut shell.store, next);
							cx.notify();
						},
					))),
			),
		)
		.child(
			field(&theme, "Finished sessions", "Keep a session in the list after it is read.").child(
				switch(shell, "settled", show_settled, cx).on_click(cx.listener(|shell, _, _, cx| {
					moves::toggle_show_settled(&mut shell.store);
					cx.notify();
				})),
			),
		)
		.child(field(&theme, "Group by checkout", "One band per project in the session list.").child(
			switch(shell, "grouped", grouped, cx).on_click(cx.listener(|shell, _, _, cx| {
				moves::toggle_group_by_folder(&mut shell.store);
				cx.notify();
			})),
		))
		.child(field(&theme, "Sound", "A tone when a session stops and wants an answer.").child(
			switch(shell, "sounds", sounds, cx).on_click(cx.listener(|shell, _, _, cx| {
				moves::toggle_sounds(&mut shell.store);
				cx.notify();
			})),
		))
		.child(ui::eyebrow("Transcript theme", &theme).pt(px(space::WIDE)))
		.child(theme_rows)
}

fn models(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let models = shell.store.models.clone();
	let current = shell
		.store
		.selected_session()
		.map(|session| session.model.clone());
	let has_session = shell.store.selected.is_some();

	let mut rows = div().flex().flex_col().w_full();
	for (index, model) in models.iter().enumerate() {
		let picked = current.as_deref() == Some(model.as_str());
		let name = model.clone();
		rows = rows.child(pick_row(shell, "model", index, model.clone(), picked, cx).on_click(
			cx.listener(move |shell, _, _, cx| {
				moves::set_model(&mut shell.store, &name);
				cx.notify();
			}),
		));
	}

	group(&theme, "The model this session sends to")
		.child(
			div()
				.text_size(px(size::SMALL))
				.text_color(theme.text_muted)
				.child(if has_session {
					"A model is per session, so two sessions in one checkout can run different ones."
				} else {
					"Pick a session first; a model belongs to a session rather than to the window."
				}),
		)
		.child(rows)
}

fn shortcuts(cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let mut rows = div().flex().flex_col().w_full();
	for (keys, what) in crate::keys::documented() {
		rows = rows.child(
			ui::line_of(space::BASE)
				.w_full()
				.py(px(space::SNUG))
				.child(
					div()
						.w(px(120.0))
						.flex_none()
						.font_family(theme.font_mono)
						.text_size(px(size::SMALL))
						.text_color(theme.text)
						.child(keys),
				)
				.child(
					div()
						.flex_1()
						.min_w(px(0.0))
						.text_size(px(size::SMALL))
						.text_color(theme.text_muted)
						.child(what),
				),
		);
	}
	group(&theme, "Keys").child(rows)
}

fn agents(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let sessions = shell.store.sessions.len();
	let working = shell.store.working();

	let rows = [
		("Engine", "Not attached".to_owned()),
		("Replies", "Produced in process".to_owned()),
		("First token", format!("{}ms", agent::FIRST_TOKEN_MS)),
		("Text", format!("{} characters every {}ms", agent::TEXT_STEP, agent::TEXT_MS)),
		("Between blocks", format!("{}ms", agent::BLOCK_MS)),
		("Command output", format!("one line every {}ms", agent::LINE_MS)),
		("Sessions", sessions.to_string()),
		("Running now", working.to_string()),
	];

	let mut table = div().flex().flex_col().w_full();
	for (label, value) in rows {
		table = table.child(
			ui::line_of(space::BASE)
				.w_full()
				.py(px(space::SNUG))
				.child(
					div()
						.w(px(150.0))
						.flex_none()
						.text_size(px(size::SMALL))
						.text_color(theme.text_muted)
						.child(label),
				)
				.child(
					div()
						.flex_1()
						.min_w(px(0.0))
						.font_family(theme.font_mono)
						.text_size(px(size::SMALL))
						.text_color(theme.text)
						.child(value),
				),
		);
	}

	group(&theme, "What is answering")
		.child(
			div()
				.text_size(px(size::SMALL))
				.text_color(theme.text_muted)
				.child(
					"Nothing outside this process is answering yet. Every reply, tool call and command \
					 below is composed here, on the timings this page lists.",
				),
		)
		.child(table)
}

// ---- the pieces a page is built from ----

fn group(theme: &Theme, heading: &'static str) -> Div {
	div()
		.flex()
		.flex_col()
		.gap(px(space::BASE))
		.w_full()
		.child(ui::eyebrow(heading, theme))
}

/// A labelled row with its control on the right.
fn field(theme: &Theme, label: &'static str, detail: &'static str) -> Div {
	div()
		.flex()
		.items_center()
		.gap(px(space::WIDE))
		.w_full()
		.py(px(space::BASE))
		.border_b_1()
		.border_color(theme.stroke)
		.child(
			div()
				.flex()
				.flex_col()
				.flex_1()
				.min_w(px(0.0))
				.child(
					div()
						.text_size(px(size::BODY))
						.text_color(theme.text)
						.child(label),
				)
				.child(
					div()
						.text_size(px(size::META))
						.text_color(theme.text_faint)
						.child(detail),
				),
		)
}

/// One half of a two-way choice.
fn segment(
	shell: &mut Shell,
	id: &'static str,
	label: &'static str,
	selected: bool,
	cx: &mut Context<Shell>,
) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::named(Channel::Control, id);
	let hover = shell.motion.value(key, now);
	let ground = if selected {
		theme.accent.opacity(0.18)
	} else {
		motion::mix(theme.sunken, theme.hover(), hover)
	};
	div()
		.id(id)
		.flex()
		.items_center()
		.h(px(26.0))
		.px(px(space::WIDE))
		.rounded(px(radius::CHIP))
		.bg(ground)
		.border_1()
		.border_color(if selected {
			theme.edge(theme.accent)
		} else {
			theme.stroke
		})
		.text_size(px(size::META))
		.text_color(if selected {
			theme.text
		} else {
			theme.text_muted
		})
		.cursor_pointer()
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.child(label)
}

/// A two-state switch. The knob glides rather than jumping, because the glide
/// is what says which way it went.
fn switch(shell: &mut Shell, id: &'static str, on: bool, cx: &mut Context<Shell>) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::named(Channel::Control, id);
	let travel = shell
		.motion
		.drive(key, motion::GLIDE, if on { 1.0 } else { 0.0 }, now);
	let track = motion::mix(theme.sunken, theme.accent, travel);
	div()
		.id(id)
		.relative()
		.flex_none()
		.w(px(38.0))
		.h(px(22.0))
		.rounded(px(radius::PILL))
		.bg(track)
		.border_1()
		.border_color(if on {
			theme.edge(theme.accent)
		} else {
			theme.stroke
		})
		.cursor_pointer()
		.child(
			div()
				.absolute()
				.top(px(2.0))
				.left(px(2.0 + 16.0 * travel))
				.size(px(16.0))
				.rounded(px(8.0))
				.bg(if on {
					theme.text_on_accent
				} else {
					theme.text_faint
				}),
		)
}

/// A small square control: the text-size steppers.
fn step(
	shell: &mut Shell,
	id: &'static str,
	glyph: &'static str,
	cx: &mut Context<Shell>,
) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::named(Channel::Control, id);
	let ground = ui::wash(&mut shell.motion, key, theme.sunken, theme.hover(), now);
	div()
		.id(id)
		.flex()
		.items_center()
		.justify_center()
		.size(px(24.0))
		.flex_none()
		.rounded(px(radius::CHIP))
		.bg(ground)
		.border_1()
		.border_color(theme.stroke)
		.text_size(px(size::SMALL))
		.text_color(theme.text_muted)
		.cursor_pointer()
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.child(glyph)
}

/// A row of a list where one entry is the current one.
fn pick_row(
	shell: &mut Shell,
	kind: &'static str,
	index: usize,
	label: String,
	picked: bool,
	cx: &mut Context<Shell>,
) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::indexed(Channel::Row, kind, index);
	let hover = shell.motion.value(key, now);
	let ground = if picked {
		theme.selected()
	} else {
		motion::mix(gpui::transparent_black(), theme.hover(), hover)
	};
	div()
		.id(gpui::ElementId::Name(format!("{kind}-{index}").into()))
		.flex()
		.items_center()
		.gap(px(space::BASE))
		.h(px(30.0))
		.w_full()
		.px(px(space::BASE))
		.rounded(px(radius::ROW))
		.bg(ground)
		.cursor_pointer()
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.child(
			ui::line(label)
				.flex_1()
				.min_w(px(0.0))
				.text_size(px(size::SMALL))
				.text_color(if picked { theme.text } else { theme.text_muted }),
		)
		.when(picked, |element| {
			element.child(
				div()
					.flex_none()
					.text_size(px(size::MICRO))
					.text_color(theme.accent)
					.child(ui::glyph::DONE),
			)
		})
}
