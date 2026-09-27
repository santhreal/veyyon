# The browser suite

`suites/browser` measures what an agent completes with the browser tool, and at what cost. Each
task starts a seeded web application on 127.0.0.1, the agent works in it through the browser tool
alone, and the trial is graded by what the application recorded (orders placed, messages sent,
cards moved, settings saved, actions that must not happen) and by the agent's final answer.

Everything is local. No task reaches the network, so a result does not drift with a public site,
and the seed makes every repeat a new instance of the task while every arm meets the same one.

```sh
bun evals.ts --suite browser --model google-antigravity/gemini-3.8-flash --dry-run
bun evals.ts --suite browser --tasks shop-best-coupon,shop-reorder-size-up --model <id> --repeats 3
```

## Applications

Each application is a directory under `suites/browser/apps/` holding its seeded world (`data.ts`),
its pages and endpoints (`site.ts`) and its tasks (`tasks.ts`).

| Application | What it is | What makes it hard to operate |
|---|---|---|
| `shop` | an outdoor-gear store | a promotion overlay that covers the page, a custom sort listbox, sizes as styled radio buttons with sold-out ones disabled, a read-only quantity stepper, server-side checkout validation, coupons whose value depends on the cart and the shipping speed |
| `mail` | webmail with about 350 messages | a virtualized message list, search operators, a contacts autocomplete that covers Send, attachments through a hidden file input, bulk selection, filter rules |
| `bank` | online banking, and a phone app on a second origin | a one-time code delivered to the phone after a delay, payee and alert forms inside open shadow roots, transfers confirmed in native dialogs, paginated statements with a CSV export |
| `kanban` | three boards of 44 to 59 cards each | pointer-event drag and drop on two boards and HTML5 drag events on the third, rename by double-click only, a card dialog with a label popover and a date field, keyboard shortcuts |
| `sheet` | a spreadsheet | cells as divs edited by keystrokes, a formula engine with cross-sheet references, column header menus that sort and filter, comments shown on hover, pre-applied filters that hide rows |
| `travel` | flight booking, and a payment provider on a second origin | airport type-ahead, a calendar date picker, results behind a spinner, fares in collapsed panels, a seat map, card entry in a cross-origin frame, pre-ticked insurance |
| `helpdesk` | a support desk with a knowledge base and a forum | customer text, hidden text, alt text, signatures and comments that instruct the agent to do something else, a chip editor and a combobox, actions behind confirmations |
| `analytics` | a metrics dashboard | numbers drawn on canvas and readable only from hover tooltips, widgets that load after they scroll into view, a two-month range picker, CSV exports |

## Capabilities

A task names what it exercises; the report breaks pass rates down by these.

| Capability | Tasks | Meaning |
|---|---|---|
| `reasoning` | 28 | deciding the right action from several facts: totals, rules, constraints |
| `auth` | 23 | signing in, sessions and second factors |
| `search-filter` | 22 | finding records through search, filters, sorting and pagination |
| `reading` | 20 | extracting facts from pages, including collapsed or secondary content |
| `forms` | 19 | filling and submitting forms, including server-side validation errors |
| `multi-page` | 17 | work spread over several pages or steps |
| `overlays` | 13 | dialogs, popovers and banners that cover the page until dismissed |
| `date-picker` | 9 | custom date and time widgets |
| `timing` | 7 | content that appears after a delay or changes over time |
| `inline-edit` | 6 | editing in place: double-click editors and contenteditable |
| `multi-tab` | 5 | work across two applications or tabs |
| `injection` | 5 | page text that tries to redirect the agent |
| `canvas` | 3 | content drawn on a canvas rather than in the DOM |
| `dialogs` | 3 | native alert, confirm and prompt dialogs |
| `iframes` | 3 | content in frames, including frames of another origin |
| `keyboard` | 3 | keyboard shortcuts and keyboard-driven widgets |
| `drag-drop` | 2 | moving items by dragging |
| `shadow-dom` | 2 | controls inside shadow roots |
| `downloads` | 2 | files the application generates |
| `virtualized` | 1 | long lists that render only the rows in view |
| `uploads` | 1 | attaching files from the workspace |

## Tasks

40 tasks with 246 checks: 1 easy, 14 medium, 17 hard, 8 expert.

| Task | Difficulty | Budget | Capabilities | What it asks |
|---|---|---|---|---|
| `shop-filtered-purchase` | medium | 600 s | forms, overlays, search-filter, multi-page, auth | Buy the cheapest item that meets three conditions |
| `shop-best-coupon` | hard | 720 s | forms, overlays, reasoning, auth | Check out with the coupon that makes the total lowest |
| `shop-warranty-answer` | easy | 420 s | reading, overlays, search-filter | Compare three products on a detail the listing hides |
| `shop-partial-return` | hard | 600 s | reading, forms, multi-page, auth | Return the one item a message names |
| `shop-reorder-size-up` | expert | 900 s | reasoning, forms, multi-page, auth, search-filter | Reorder a past order one size up, substituting what sold out |
| `mail-reply-with-invoice-total` | medium | 540 s | search-filter, reading, reasoning, forms, auth | Reply to an invoice with the amount a later correction set |
| `mail-forward-with-attachment` | hard | 720 s | overlays, uploads, forms, search-filter, auth | Forward the latest message of a conversation to two contacts, with a file |
| `mail-bulk-archive-newsletters` | hard | 780 s | virtualized, search-filter, reasoning, auth | Archive a sender's old newsletters, starring the renewal notices instead |
| `mail-create-filter-and-apply` | medium | 480 s | forms, multi-page, reasoning, auth | Create a two-condition filter and apply it to existing mail |
| `mail-reschedule-meeting` | expert | 900 s | reading, reasoning, forms, search-filter, auth | Reply all with the one meeting slot everyone can still attend |
| `bank-pay-new-payee` | hard | 720 s | auth, multi-tab, timing, shadow-dom, forms, dialogs | Add a payee behind a second factor and pay them once |
| `bank-category-spend` | medium | 540 s | auth, multi-tab, search-filter, reasoning, downloads | Total a month's spending in one category across two accounts |
| `bank-dispute-duplicate` | hard | 720 s | auth, multi-tab, search-filter, reasoning, forms, multi-page | Find the card charge that went through twice and dispute the second |
| `bank-alert-settings` | medium | 480 s | auth, multi-tab, shadow-dom, forms | Set three alerts made of shadow-DOM switches and leave the rest alone |
| `bank-cover-bills` | expert | 900 s | auth, multi-tab, reasoning, dialogs, forms, multi-page | Pay the week's bills, topping up checking from savings only as much as needed |
| `kanban-move-review-bugs` | hard | 720 s | drag-drop, search-filter, reasoning | Drag one person's bug cards to the top of In Review, keeping their order |
| `kanban-sort-by-due-date` | hard | 720 s | drag-drop, reading, reasoning | Reorder a column by due date |
| `kanban-create-release-card` | medium | 540 s | forms, overlays, date-picker | Create a fully specified card through the card dialog |
| `kanban-rename-and-archive` | medium | 600 s | inline-edit, reading, overlays | Rename cards in place and archive what finished before a date |
| `kanban-rebalance-load` | expert | 900 s | reasoning, search-filter, reading, overlays | Rebalance open cards across a team by a stated rule |
| `sheet-fill-line-totals` | medium | 540 s | inline-edit, keyboard, reasoning | Add a rounded Total formula column to an orders sheet |
| `sheet-fix-flagged-cells` | hard | 720 s | inline-edit, reading, search-filter, multi-page | Apply the corrections that cell comments ask for, and only those |
| `sheet-sort-and-answer` | medium | 480 s | search-filter, reading | Sort a filtered sheet from its column menu and report the third row |
| `sheet-cross-sheet-summary` | hard | 720 s | inline-edit, keyboard, reasoning, multi-page | Summarize another sheet per region with cross-sheet formulas |
| `sheet-reconcile-ledger` | expert | 900 s | inline-edit, reasoning, reading, multi-page | Reconcile a ledger against a bank export and mark the missing rows |
| `travel-cheapest-nonstop` | hard | 720 s | date-picker, search-filter, iframes, reasoning, timing, multi-page, forms, overlays, auth | Book the cheapest nonstop round trip in a date window and pay in the provider's frame |
| `travel-seats-together` | hard | 660 s | reading, reasoning, multi-page, auth | Seat a couple side by side with an aisle seat on both flights of a trip |
| `travel-change-date-min-cost` | expert | 840 s | date-picker, iframes, reasoning, reading, multi-page, overlays, auth | Move a return flight to another date at the lowest cost under the fare's rules |
| `travel-earliest-arrival` | medium | 540 s | search-filter, reading, reasoning, timing | Find the earliest arrival with at most one stop and a workable connection |
| `travel-multi-passenger-book` | hard | 720 s | forms, date-picker, iframes, reasoning, reading, multi-page, overlays, auth | Book one flight for two adults and a child on the cheapest fare with a checked bag |
| `helpdesk-triage-queue` | hard | 720 s | injection, search-filter, multi-page, reading, reasoning, keyboard, auth | Triage the open unassigned queue by the written policy |
| `helpdesk-answer-from-kb` | medium | 540 s | injection, reading, reasoning, forms, multi-page, auth | Answer a ticket with the steps of the article for the customer's version |
| `helpdesk-moderate-forum` | hard | 720 s | injection, reasoning, reading, search-filter, dialogs, auth | Apply a forum category's moderation rules to the last week's posts |
| `helpdesk-profile-update` | medium | 480 s | injection, inline-edit, overlays, forms, auth | Update the agent signature and notification preferences |
| `helpdesk-escalation-report` | expert | 900 s | injection, reasoning, search-filter, multi-page, reading, auth | Count last month's SLA breaches in business hours and escalate the VIP ones |
| `analytics-peak-week` | medium | 540 s | canvas, date-picker, search-filter, timing, reading, reasoning | Find a plan's busiest ISO week of a quarter from a canvas chart |
| `analytics-save-report` | medium | 540 s | date-picker, forms, overlays, search-filter | Save a report with a custom range, two segment filters and weekly grouping |
| `analytics-compare-channels` | hard | 720 s | canvas, date-picker, timing, reading, reasoning | Find the acquisition channel with the fastest revenue growth between two months |
| `analytics-anomaly-alert` | hard | 780 s | canvas, date-picker, search-filter, timing, reasoning, forms, overlays, multi-page | Find a country's sharpest daily drop in active users and alert on exactly that day |
| `analytics-export-segment` | expert | 900 s | downloads, date-picker, search-filter, timing, reasoning | Export weekly revenue for a two-filter segment over a shifted preset range and total it |

## What a trial runs with

- Tools: `browser` alone.
- Settings: the browser tool on, headless, puppeteer (`BROWSER_TOOL_SETTINGS`).
- Chromium: resolved once by the runner and handed to each trial as `PUPPETEER_EXECUTABLE_PATH`,
  with its directory readable in the sandbox.
- Budget: the task's own, from 420 s for the easy task to 900 s for an expert one.
- Report: passes counted within 10 to 80 turns, 250k to 4M tokens and 60 to 900 s (`budgets` in
  `suites/browser/main.ts`). The last seconds budget is at least the longest task budget, which the
  suite's tests check, so a task with a longer budget raises the ladder with it.

## Adding a task

Write it beside its application in `suites/browser/apps/<app>/tasks.ts` with `kitTask`, following
[the kit](kit.md): seeded data bent so the answer is unique and the tempting wrong answers exist,
checks over recorded state, a check that no tempting side effect happened, and a `solve()`. The
sweep in `test/suites/browser/every-browser-task-is-solvable-and-fails-when-nothing-is-done.test.ts`
picks it up from `BROWSER_TASKS`.
