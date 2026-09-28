//! The menus the composer opens above itself: the model picker, the thinking
//! level picker, the session mode and the prompt history.

use gpui::{
	Anchor, AnyElement, App, Context, Entity, Pixels, Point, Subscription, Window, point, prelude::*,
};
use veyyon_desktop_model::{HostAction, HostActionKind, SessionMode, SettableMode, SurfaceId};
use veyyon_desktop_ui::{
	icons::{Icon, IconName},
	overlays::{Menu, MenuEvent, MenuItem, MenuRow, Popover},
	theme::{size, space},
};

use super::Composer;

/// Longest prompt a history row shows before it is cut.
const HISTORY_LABEL_CHARS: usize = 80;

/// What a row of a picker does.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Pick {
	Model { provider: String, id: String },
	RefreshModels,
	ToggleFast,
	Thinking(String),
	Mode(SettableMode),
	ReviewPlan,
	Prompt(String),
}

/// A menu in a popover that opens upward from a point.
struct Picker {
	menu:    Entity<Menu>,
	popover: Entity<Popover>,
	picks:   Vec<Option<Pick>>,
}

impl Picker {
	fn new(cx: &mut Context<Composer>) -> Self {
		let menu = cx.new(|cx| Menu::new(Vec::new(), cx));
		let popover = cx.new(|cx| Popover::new(&menu, cx));
		Self { menu, popover, picks: Vec::new() }
	}

	fn fill(&mut self, rows: Vec<(MenuItem, Option<Pick>)>, cx: &mut App) {
		let (items, picks): (Vec<_>, Vec<_>) = rows.into_iter().unzip();
		self.picks = picks;
		self.menu.update(cx, |menu, cx| menu.set_items(items, cx));
	}

	fn is_open(&self, cx: &App) -> bool {
		self.popover.read(cx).is_open()
	}
}

/// The composer's pickers.
pub(super) struct Pickers {
	models:   Picker,
	thinking: Picker,
	modes:    Picker,
	history:  Picker,
}

/// A row marked as the current choice.
fn row(label: impl Into<gpui::SharedString>, current: bool) -> MenuRow {
	let row = MenuRow::new(label);
	if current {
		row.leading(|_, _| {
			Icon::new(IconName::Check)
				.size(size::ICON_SM)
				.into_any_element()
		})
	} else {
		row
	}
}

impl Pickers {
	/// The pickers, closed, and the subscriptions to their menus.
	pub(super) fn new(window: &Window, cx: &mut Context<Composer>) -> (Self, Vec<Subscription>) {
		let pickers = Self {
			models:   Picker::new(cx),
			thinking: Picker::new(cx),
			modes:    Picker::new(cx),
			history:  Picker::new(cx),
		};
		let subscriptions = pickers
			.all()
			.into_iter()
			.map(|picker| &picker.menu)
			.map(|menu| cx.subscribe_in(menu, window, Composer::on_picker_event))
			.collect();
		(pickers, subscriptions)
	}

	/// The popovers, rendered anywhere in the composer's tree.
	pub(super) fn popovers(&self) -> impl Iterator<Item = Entity<Popover>> + '_ {
		self.all().into_iter().map(|picker| picker.popover.clone())
	}

	const fn all(&self) -> [&Picker; 4] {
		[&self.models, &self.thinking, &self.modes, &self.history]
	}
}

impl Composer {
	/// The top-left corner of the composer column, where a picker opens
	/// upward from.
	pub(super) fn picker_anchor(&self) -> Point<Pixels> {
		let bounds = self.bounds.unwrap_or_default();
		let column = (bounds.size.width - space::S6 * 2.0).min(size::COLUMN_MAX);
		let left = bounds.origin.x + ((bounds.size.width - column) / 2.0).max(space::S6);
		point(left, bounds.origin.y)
	}

	fn open_picker(
		&self,
		which: fn(&Pickers) -> &Picker,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let at = self.picker_anchor();
		let picker = which(&self.pickers);
		picker.menu.update(cx, |menu, cx| menu.highlight(None, cx));
		picker.popover.update(cx, |popover, cx| {
			popover.open(at, Anchor::BottomLeft, None, window, cx);
		});
	}

	/// `composer::OpenModelPicker`: lists the catalog, asking the host for it
	/// when none has arrived.
	pub(super) fn open_models(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let empty = self
			.app
			.read(cx)
			.store()
			.domains
			.models
			.as_ref()
			.is_none_or(|models| models.models.is_empty());
		if empty {
			self.send_for_session(
				|session| (HostAction::RefreshModels, SurfaceId::ComposerModelSelector(session)),
				cx,
			);
		}
		self.fill_models(cx);
		self.open_picker(|pickers| &pickers.models, window, cx);
	}

	/// `composer::OpenThinkingPicker`.
	pub(super) fn open_thinking(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		self.fill_thinking(cx);
		self.open_picker(|pickers| &pickers.thinking, window, cx);
	}

	/// Opens the session mode menu.
	pub(super) fn open_modes(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let mode = self
			.session
			.as_ref()
			.and_then(|session| self.app.read(cx).store().modes.get(session).cloned());
		let choices = [
			("Plan mode", SettableMode::Plan, Some(SessionMode::Plan)),
			("Vibe mode", SettableMode::Vibe, Some(SessionMode::Vibe)),
			("Loop mode", SettableMode::Loop, Some(SessionMode::Loop)),
			("No mode", SettableMode::None, None),
		];
		let mut rows: Vec<(MenuItem, Option<Pick>)> = choices
			.into_iter()
			.map(|(label, settable, held)| {
				(row(label, mode == held).into(), Some(Pick::Mode(settable)))
			})
			.collect();
		if matches!(mode, Some(SessionMode::Plan)) {
			rows.push((MenuItem::Separator, None));
			rows.push((MenuRow::new("Review the plan").into(), Some(Pick::ReviewPlan)));
		}
		self.pickers.modes.fill(rows, cx);
		self.open_picker(|pickers| &pickers.modes, window, cx);
	}

	/// Opens the history menu on the prompts the host's lookup matched.
	pub(super) fn open_history(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		self.fill_history(cx);
		self.open_picker(|pickers| &pickers.history, window, cx);
	}

	/// The catalog changed: an open model or thinking picker lists it.
	pub(super) fn models_changed(&mut self, cx: &mut Context<Self>) {
		if self.pickers.models.is_open(cx) {
			self.fill_models(cx);
		}
		if self.pickers.thinking.is_open(cx) {
			self.fill_thinking(cx);
		}
	}

	/// The host's prompt history changed: an open history menu lists it.
	pub(super) fn history_changed(&mut self, cx: &mut Context<Self>) {
		if self.pickers.history.is_open(cx) {
			self.fill_history(cx);
		}
	}

	fn fill_models(&mut self, cx: &mut Context<Self>) {
		let mut rows = Vec::new();
		if let Some(models) = &self.app.read(cx).store().domains.models {
			let mut provider = None;
			for model in &models.models {
				if provider != Some(model.provider.as_str()) {
					provider = Some(model.provider.as_str());
					rows.push((MenuItem::header(model.provider.clone()), None));
				}
				let current = models
					.current
					.as_ref()
					.is_some_and(|current| current.provider == model.provider && current.id == model.id);
				let pick = Pick::Model { provider: model.provider.clone(), id: model.id.clone() };
				rows.push((row(model.name.clone(), current).into(), Some(pick)));
			}
		}
		if !rows.is_empty() {
			rows.push((MenuItem::Separator, None));
		}
		rows.push((MenuRow::new("Toggle fast mode").hint("/fast").into(), Some(Pick::ToggleFast)));
		rows.push((MenuRow::new("Refresh models").into(), Some(Pick::RefreshModels)));
		self.pickers.models.fill(rows, cx);
	}

	fn fill_thinking(&mut self, cx: &mut Context<Self>) {
		let rows = self
			.app
			.read(cx)
			.store()
			.domains
			.models
			.as_ref()
			.map_or_else(Vec::new, |models| {
				models
					.thinking_levels
					.iter()
					.map(|level| {
						let current = models.thinking_level.as_ref() == Some(level);
						(row(level.clone(), current).into(), Some(Pick::Thinking(level.clone())))
					})
					.collect()
			});
		self.pickers.thinking.fill(rows, cx);
	}

	fn fill_history(&mut self, cx: &mut Context<Self>) {
		let rows = self
			.app
			.read(cx)
			.store()
			.domains
			.prompt_history
			.as_ref()
			.map_or_else(Vec::new, |view| {
				view
					.entries
					.iter()
					.map(|entry| {
						let line = entry.prompt.lines().next().unwrap_or_default();
						let label: String = line.chars().take(HISTORY_LABEL_CHARS).collect();
						(MenuRow::new(label).into(), Some(Pick::Prompt(entry.prompt.clone())))
					})
					.collect()
			});
		let rows = if rows.is_empty() {
			vec![(MenuRow::new("No earlier prompts").disabled(true).into(), None)]
		} else {
			rows
		};
		self.pickers.history.fill(rows, cx);
	}

	/// `composer::CycleThinkingLevel`: the level after the current one.
	pub(super) fn cycle_thinking(&self, cx: &mut Context<Self>) {
		let next = self
			.app
			.read(cx)
			.store()
			.domains
			.models
			.as_ref()
			.and_then(|models| {
				let levels = &models.thinking_levels;
				let at = models
					.thinking_level
					.as_ref()
					.and_then(|level| levels.iter().position(|held| held == level));
				levels
					.get(at.map_or(0, |at| (at + 1) % levels.len()))
					.cloned()
			});
		if let Some(level) = next {
			self.send_for_session(
				|session| {
					(
						HostAction::SetThinkingLevel { level },
						SurfaceId::ComposerThinkingSelector(session),
					)
				},
				cx,
			);
		}
	}

	fn on_picker_event(
		&mut self,
		menu: &Entity<Menu>,
		event: &MenuEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let Some(picker) = self
			.pickers
			.all()
			.into_iter()
			.find(|picker| &picker.menu == menu)
		else {
			return;
		};
		let pick = match event {
			MenuEvent::Picked(ix) => picker.picks.get(*ix).cloned().flatten(),
			MenuEvent::Dismissed => None,
		};
		let popover = picker.popover.clone();
		popover.update(cx, |popover, cx| popover.close(window, cx));
		match pick {
			Some(Pick::Model { provider, id }) => {
				self.app.update(cx, |app, cx| {
					app.select_model(provider, id, cx);
				});
			},
			Some(Pick::RefreshModels) => {
				self.send_for_session(
					|session| (HostAction::RefreshModels, SurfaceId::ComposerModelSelector(session)),
					cx,
				);
			},
			Some(Pick::ToggleFast) => self.toggle_fast(cx),
			Some(Pick::Thinking(level)) => self.send_for_session(
				|session| {
					(
						HostAction::SetThinkingLevel { level },
						SurfaceId::ComposerThinkingSelector(session),
					)
				},
				cx,
			),
			Some(Pick::Mode(mode)) => self.set_mode(mode, cx),
			Some(Pick::ReviewPlan) => self.review_plan(cx),
			Some(Pick::Prompt(prompt)) => self.insert_text(&prompt, window, cx),
			None => {},
		}
	}

	/// `composer::ToggleFast`: flips the priority service tier.
	pub(super) fn toggle_fast(&self, cx: &mut Context<Self>) {
		self.send_for_session(
			|session| {
				let action =
					HostAction::RunCommand { session: session.clone(), text: "/fast".to_owned() };
				(action, SurfaceId::ComposerModelSelector(session))
			},
			cx,
		);
	}

	/// Whether the host takes `kind` now, and the reason it does not.
	pub(super) fn refusal(&self, kind: HostActionKind, cx: &App) -> Option<String> {
		self.app.read(cx).refusal(kind)
	}

	/// The popovers the pickers draw in.
	pub(super) fn render_pickers(&self) -> impl Iterator<Item = AnyElement> + '_ {
		self.pickers.popovers().map(IntoElement::into_any_element)
	}
}
