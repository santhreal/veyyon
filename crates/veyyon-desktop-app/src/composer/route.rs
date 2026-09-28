//! Actions that reach a region the focus is not in.
//!
//! The composer and the dock are siblings of whatever holds focus: an action
//! the palette runs or a shortcut pressed in the sidebar dispatches along the
//! focus path and never passes them. Each registers its entity per window, and
//! an App-level listener hands the action to the one in the active window, or
//! to the only one when no window is active.
//!
//! A region writes its actions once, as a table generic over [`Registry`], and
//! registers that table twice: on its own element through [`OnElement`], so a
//! key pressed inside it is handled at once, and on the App through
//! [`installer`], so the palette or a key pressed elsewhere reaches it.

use std::marker::PhantomData;

use gpui::{
	Action, AnyWindowHandle, App, Context, Div, Entity, Global, Stateful, WeakEntity, Window,
	prelude::*,
};

/// A handler of the action `A` on the region `V`.
pub type Handler<V, A> = fn(&mut V, &A, &mut Window, &mut Context<V>);

/// Where a region's action table registers each handler.
pub trait Registry<V: 'static>: Sized {
	/// Registers `handler` for `A`.
	fn add<A: Action + Clone>(self, handler: Handler<V, A>) -> Self;
}

/// Registers on the App, routed to the `V` of the active window.
pub struct OnApp<'a, V>(&'a mut App, PhantomData<fn() -> V>);

impl<V: 'static> Registry<V> for OnApp<'_, V> {
	fn add<A: Action + Clone>(self, handler: Handler<V, A>) -> Self {
		route::<A, V>(self.0, handler);
		self
	}
}

/// Registers on the region's own element.
pub struct OnElement<'a, 'b, V: 'static> {
	/// The element the listeners go on.
	pub element: Stateful<Div>,
	/// The region's context.
	pub cx:      &'a mut Context<'b, V>,
}

impl<V: 'static> Registry<V> for OnElement<'_, '_, V> {
	fn add<A: Action + Clone>(mut self, handler: Handler<V, A>) -> Self {
		self.element = self.element.on_action(self.cx.listener(handler));
		self
	}
}

/// Marks that the App-level routes of `V` are registered.
struct Installed<V>(PhantomData<fn() -> V>);

impl<V: 'static> Global for Installed<V> {}

/// The registry that routes `V`'s actions from the App, the first time it is
/// asked for; `None` once they are registered.
pub fn installer<V: 'static>(cx: &mut App) -> Option<OnApp<'_, V>> {
	if cx.has_global::<Installed<V>>() {
		return None;
	}
	cx.set_global(Installed::<V>(PhantomData));
	Some(OnApp(cx, PhantomData))
}

/// The live entity of type `V` in each window.
pub struct Routes<V: 'static>(Vec<(AnyWindowHandle, WeakEntity<V>)>);

impl<V: 'static> Default for Routes<V> {
	fn default() -> Self {
		Self(Vec::new())
	}
}

impl<V: 'static> Global for Routes<V> {}

/// Records `view` as the entity of its type in `window`, replacing an earlier
/// one and forgetting every entity that was dropped.
pub fn register<V: 'static>(window: &Window, view: &Entity<V>, cx: &mut App) {
	let handle = window.window_handle();
	let routes = &mut cx.default_global::<Routes<V>>().0;
	routes.retain(|(window, view)| *window != handle && view.upgrade().is_some());
	routes.push((handle, view.downgrade()));
}

/// The entity of type `V` an App-level action goes to.
fn target<V: 'static>(cx: &App) -> Option<(AnyWindowHandle, Entity<V>)> {
	let routes = &cx.try_global::<Routes<V>>()?.0;
	let live = || {
		routes
			.iter()
			.filter_map(|(window, view)| Some((*window, view.upgrade()?)))
	};
	if let Some(active) = cx.active_window()
		&& let Some(found) = live().find(|(window, _)| *window == active)
	{
		return Some(found);
	}
	let mut all = live();
	let only = all.next()?;
	all.next().is_none().then_some(only)
}

/// Sends every `A` dispatched outside `V`'s own tree to `handler` on the `V`
/// of the active window.
///
/// The listener runs while the dispatching window is borrowed, so the handler
/// runs once the dispatch returns, on the same effect cycle.
fn route<A, V>(cx: &mut App, handler: Handler<V, A>)
where
	A: Action + Clone,
	V: 'static,
{
	cx.on_action(move |action: &A, cx| {
		let Some((window, view)) = target::<V>(cx) else {
			return;
		};
		let action = action.clone();
		cx.defer(move |cx| {
			let _ = window.update(cx, |_, window, cx| {
				view.update(cx, |view, cx| handler(view, &action, window, cx));
			});
		});
	});
}
