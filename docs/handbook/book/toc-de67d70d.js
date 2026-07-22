// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="introduction.html">The Veyyon handbook</a></span></li><li class="chapter-item expanded "><li class="part-title">Understand Veyyon</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="foundations/how-to-read.html"><strong aria-hidden="true">1.</strong> How to read this book</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="why/value.html"><strong aria-hidden="true">2.</strong> Overview</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="why/innovations.html"><strong aria-hidden="true">3.</strong> Mechanisms</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="why/argot.html"><strong aria-hidden="true">4.</strong> Argot</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="foundations/thesis.html"><strong aria-hidden="true">5.</strong> Harness design goals</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="foundations/architecture.html"><strong aria-hidden="true">6.</strong> Architecture at a glance</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="why/performance.html"><strong aria-hidden="true">7.</strong> Performance</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="benefits/first-attempt-edits.html"><strong aria-hidden="true">8.</strong> Why it helps</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="benefits/lower-cost.html"><strong aria-hidden="true">8.1.</strong> Context size and retries</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="benefits/model-choice.html"><strong aria-hidden="true">8.2.</strong> Model and provider selection</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="benefits/safety-errors.html"><strong aria-hidden="true">8.3.</strong> Approvals and errors</a></span></li></ol><li class="chapter-item expanded "><li class="part-title">Get started</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/install.html"><strong aria-hidden="true">9.</strong> Install</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/authentication.html"><strong aria-hidden="true">10.</strong> Signing in</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/quickstart.html"><strong aria-hidden="true">11.</strong> Quickstart</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/getting-started.html"><strong aria-hidden="true">12.</strong> Getting started</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/configuring-providers.html"><strong aria-hidden="true">13.</strong> Configuring providers</a></span></li><li class="chapter-item expanded "><li class="part-title">Core concepts</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="concepts/index.html"><strong aria-hidden="true">14.</strong> Core concepts</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="concepts/sessions-turns-threads.html"><strong aria-hidden="true">14.1.</strong> Sessions, turns, and threads</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="concepts/permission-model.html"><strong aria-hidden="true">14.2.</strong> Permission model</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="concepts/model-contract.html"><strong aria-hidden="true">14.3.</strong> Model contract</a></span></li></ol><li class="chapter-item expanded "><li class="part-title">Everyday use</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/editing.html"><strong aria-hidden="true">15.</strong> Editing and repair</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/sandbox.html"><strong aria-hidden="true">16.</strong> Approvals</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="using/safety.html"><strong aria-hidden="true">16.1.</strong> Safety</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/models.html"><strong aria-hidden="true">17.</strong> Models and providers</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/sessions.html"><strong aria-hidden="true">18.</strong> Sessions</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/cockpit.html"><strong aria-hidden="true">19.</strong> Cockpit</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/keybindings.html"><strong aria-hidden="true">20.</strong> Keybindings and Vim mode</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/web-search.html"><strong aria-hidden="true">21.</strong> Web search</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/review.html"><strong aria-hidden="true">22.</strong> Code review</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/exec.html"><strong aria-hidden="true">23.</strong> Non-interactive mode</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/themes.html"><strong aria-hidden="true">24.</strong> Themes and identity</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/task-guides.html"><strong aria-hidden="true">25.</strong> Task guides</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/examples.html"><strong aria-hidden="true">26.</strong> Examples</a></span></li><li class="chapter-item expanded "><li class="part-title">Extend and customize</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/plan-mode.html"><strong aria-hidden="true">27.</strong> Plan mode, goals, and vibe</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/skills.html"><strong aria-hidden="true">28.</strong> Skills</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="features/skills-authoring.html"><strong aria-hidden="true">28.1.</strong> Skills authoring</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/plugins.html"><strong aria-hidden="true">29.</strong> Plugins</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/hooks.html"><strong aria-hidden="true">30.</strong> Hooks</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="features/hooks-guide.html"><strong aria-hidden="true">30.1.</strong> Hooks guide</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/mcp.html"><strong aria-hidden="true">31.</strong> MCP</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="using/mcp-setup.html"><strong aria-hidden="true">31.1.</strong> MCP setup</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/connectors.html"><strong aria-hidden="true">32.</strong> Connectors and Apps</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/branching.html"><strong aria-hidden="true">33.</strong> Session branching</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/memory.html"><strong aria-hidden="true">34.</strong> Memory</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/profiles.html"><strong aria-hidden="true">35.</strong> Profiles</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="using/roles-and-profiles.html"><strong aria-hidden="true">35.1.</strong> Roles and profiles</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="features/personalities.html"><strong aria-hidden="true">35.2.</strong> Personalities</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/speech.html"><strong aria-hidden="true">36.</strong> Speech</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/export-import.html"><strong aria-hidden="true">37.</strong> Export and import</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/configuration.html"><strong aria-hidden="true">38.</strong> Configuration</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="features/feature-flags.html"><strong aria-hidden="true">38.1.</strong> Feature flags</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="using/extending.html"><strong aria-hidden="true">38.2.</strong> Tools, skills, and extension data</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/migration-guide.html"><strong aria-hidden="true">39.</strong> Migration guide</a></span></li><li class="chapter-item expanded "><li class="part-title">Reference</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="reference/index.html"><strong aria-hidden="true">40.</strong> Reference</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="reference/cli.html"><strong aria-hidden="true">40.1.</strong> CLI reference</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="reference/slash-commands.html"><strong aria-hidden="true">40.2.</strong> Slash commands</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="reference/tools.html"><strong aria-hidden="true">40.3.</strong> Tools reference</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="reference/keybindings-ref.html"><strong aria-hidden="true">40.4.</strong> Keyboard shortcuts</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="reference/environment.html"><strong aria-hidden="true">40.5.</strong> Environment variables</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="reference/exit-codes.html"><strong aria-hidden="true">40.6.</strong> Exit codes</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="reference/file-locations.html"><strong aria-hidden="true">40.7.</strong> File locations</a></span></li></ol><li class="chapter-item expanded "><li class="part-title">Under the hood</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="architecture/overview.html"><strong aria-hidden="true">41.</strong> Architecture overview</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="architecture/sandbox.html"><strong aria-hidden="true">41.1.</strong> Approvals internals</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="architecture/session-turn.html"><strong aria-hidden="true">41.2.</strong> Session and turn internals</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="architecture/config.html"><strong aria-hidden="true">41.3.</strong> Config layering</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="architecture/mcp.html"><strong aria-hidden="true">41.4.</strong> MCP internals</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="architecture/providers.html"><strong aria-hidden="true">41.5.</strong> Providers internals</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="foundations/verification.html"><strong aria-hidden="true">42.</strong> Testing and verification</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="repair/overview.html"><strong aria-hidden="true">43.</strong> Repair</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="repair/cascade.html"><strong aria-hidden="true">43.1.</strong> The repair cascade</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="repair/per-model.html"><strong aria-hidden="true">43.2.</strong> Per-model posture</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="repair/soundness.html"><strong aria-hidden="true">43.3.</strong> Soundness and telemetry</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="edit/engine.html"><strong aria-hidden="true">44.</strong> The edit engine</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="edit/edit-repair.html"><strong aria-hidden="true">44.1.</strong> Repair on edits</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="edit/roadmap.html"><strong aria-hidden="true">44.2.</strong> Edit-path properties</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="models/providers.html"><strong aria-hidden="true">45.</strong> Provider stack</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="models/prompts.html"><strong aria-hidden="true">45.1.</strong> Execution-order prompts</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="context/reads-search.html"><strong aria-hidden="true">46.</strong> Context</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="context/goal-state.html"><strong aria-hidden="true">46.1.</strong> Goal state and long sessions</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="context/compaction-memory.html"><strong aria-hidden="true">46.2.</strong> Compaction and project memory</a></span></li></ol><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="router/role-routing.html"><strong aria-hidden="true">47.</strong> Role policy</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="observability/overview.html"><strong aria-hidden="true">48.</strong> Observability</a></span></li><li class="chapter-item expanded "><li class="part-title">Troubleshooting</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/troubleshooting.html"><strong aria-hidden="true">49.</strong> Troubleshooting</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="using/faq.html"><strong aria-hidden="true">50.</strong> FAQ</a></span></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="features/doctor.html"><strong aria-hidden="true">51.</strong> Diagnostics and health</a></span></li><li class="chapter-item expanded "><li class="part-title">Acknowledgements</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="acknowledgements.html"><strong aria-hidden="true">52.</strong> Credits and licenses</a></span></li><li class="chapter-item expanded "><li class="part-title">Appendix</li></li><li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="appendix/glossary.html"><strong aria-hidden="true">53.</strong> Glossary</a></span></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString().split('#')[0].split('?')[0];
        if (current_page.endsWith('/')) {
            current_page += 'index.html';
        }
        const links = Array.prototype.slice.call(this.querySelectorAll('a'));
        const l = links.length;
        for (let i = 0; i < l; ++i) {
            const link = links[i];
            const href = link.getAttribute('href');
            if (href && !href.startsWith('#') && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The 'index' page is supposed to alias the first chapter in the book.
            if (link.href === current_page
                || i === 0
                && path_to_root === ''
                && current_page.endsWith('/index.html')) {
                link.classList.add('active');
                let parent = link.parentElement;
                while (parent) {
                    if (parent.tagName === 'LI' && parent.classList.contains('chapter-item')) {
                        parent.classList.add('expanded');
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', e => {
            if (e.target.tagName === 'A') {
                const clientRect = e.target.getBoundingClientRect();
                const sidebarRect = this.getBoundingClientRect();
                sessionStorage.setItem('sidebar-scroll-offset', clientRect.top - sidebarRect.top);
            }
        }, { passive: true });
        const sidebarScrollOffset = sessionStorage.getItem('sidebar-scroll-offset');
        sessionStorage.removeItem('sidebar-scroll-offset');
        if (sidebarScrollOffset !== null) {
            // preserve sidebar scroll position when navigating via links within sidebar
            const activeSection = this.querySelector('.active');
            if (activeSection) {
                const clientRect = activeSection.getBoundingClientRect();
                const sidebarRect = this.getBoundingClientRect();
                const currentOffset = clientRect.top - sidebarRect.top;
                this.scrollTop += currentOffset - parseFloat(sidebarScrollOffset);
            }
        } else {
            // scroll sidebar to current active section when navigating via
            // 'next/previous chapter' buttons
            const activeSection = document.querySelector('#mdbook-sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        const sidebarAnchorToggles = document.querySelectorAll('.chapter-fold-toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(el => {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define('mdbook-sidebar-scrollbox', MDBookSidebarScrollbox);


// ---------------------------------------------------------------------------
// Support for dynamically adding headers to the sidebar.

(function() {
    // This is used to detect which direction the page has scrolled since the
    // last scroll event.
    let lastKnownScrollPosition = 0;
    // This is the threshold in px from the top of the screen where it will
    // consider a header the "current" header when scrolling down.
    const defaultDownThreshold = 150;
    // Same as defaultDownThreshold, except when scrolling up.
    const defaultUpThreshold = 300;
    // The threshold is a virtual horizontal line on the screen where it
    // considers the "current" header to be above the line. The threshold is
    // modified dynamically to handle headers that are near the bottom of the
    // screen, and to slightly offset the behavior when scrolling up vs down.
    let threshold = defaultDownThreshold;
    // This is used to disable updates while scrolling. This is needed when
    // clicking the header in the sidebar, which triggers a scroll event. It
    // is somewhat finicky to detect when the scroll has finished, so this
    // uses a relatively dumb system of disabling scroll updates for a short
    // time after the click.
    let disableScroll = false;
    // Array of header elements on the page.
    let headers;
    // Array of li elements that are initially collapsed headers in the sidebar.
    // I'm not sure why eslint seems to have a false positive here.
    // eslint-disable-next-line prefer-const
    let headerToggles = [];
    // This is a debugging tool for the threshold which you can enable in the console.
    let thresholdDebug = false;

    // Updates the threshold based on the scroll position.
    function updateThreshold() {
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const windowHeight = window.innerHeight;
        const documentHeight = document.documentElement.scrollHeight;

        // The number of pixels below the viewport, at most documentHeight.
        // This is used to push the threshold down to the bottom of the page
        // as the user scrolls towards the bottom.
        const pixelsBelow = Math.max(0, documentHeight - (scrollTop + windowHeight));
        // The number of pixels above the viewport, at least defaultDownThreshold.
        // Similar to pixelsBelow, this is used to push the threshold back towards
        // the top when reaching the top of the page.
        const pixelsAbove = Math.max(0, defaultDownThreshold - scrollTop);
        // How much the threshold should be offset once it gets close to the
        // bottom of the page.
        const bottomAdd = Math.max(0, windowHeight - pixelsBelow - defaultDownThreshold);
        let adjustedBottomAdd = bottomAdd;

        // Adjusts bottomAdd for a small document. The calculation above
        // assumes the document is at least twice the windowheight in size. If
        // it is less than that, then bottomAdd needs to be shrunk
        // proportional to the difference in size.
        if (documentHeight < windowHeight * 2) {
            const maxPixelsBelow = documentHeight - windowHeight;
            const t = 1 - pixelsBelow / Math.max(1, maxPixelsBelow);
            const clamp = Math.max(0, Math.min(1, t));
            adjustedBottomAdd *= clamp;
        }

        let scrollingDown = true;
        if (scrollTop < lastKnownScrollPosition) {
            scrollingDown = false;
        }

        if (scrollingDown) {
            // When scrolling down, move the threshold up towards the default
            // downwards threshold position. If near the bottom of the page,
            // adjustedBottomAdd will offset the threshold towards the bottom
            // of the page.
            const amountScrolledDown = scrollTop - lastKnownScrollPosition;
            const adjustedDefault = defaultDownThreshold + adjustedBottomAdd;
            threshold = Math.max(adjustedDefault, threshold - amountScrolledDown);
        } else {
            // When scrolling up, move the threshold down towards the default
            // upwards threshold position. If near the bottom of the page,
            // quickly transition the threshold back up where it normally
            // belongs.
            const amountScrolledUp = lastKnownScrollPosition - scrollTop;
            const adjustedDefault = defaultUpThreshold - pixelsAbove
                + Math.max(0, adjustedBottomAdd - defaultDownThreshold);
            threshold = Math.min(adjustedDefault, threshold + amountScrolledUp);
        }

        if (documentHeight <= windowHeight) {
            threshold = 0;
        }

        if (thresholdDebug) {
            const id = 'mdbook-threshold-debug-data';
            let data = document.getElementById(id);
            if (data === null) {
                data = document.createElement('div');
                data.id = id;
                data.style.cssText = `
                    position: fixed;
                    top: 50px;
                    right: 10px;
                    background-color: 0xeeeeee;
                    z-index: 9999;
                    pointer-events: none;
                `;
                document.body.appendChild(data);
            }
            data.innerHTML = `
                <table>
                  <tr><td>documentHeight</td><td>${documentHeight.toFixed(1)}</td></tr>
                  <tr><td>windowHeight</td><td>${windowHeight.toFixed(1)}</td></tr>
                  <tr><td>scrollTop</td><td>${scrollTop.toFixed(1)}</td></tr>
                  <tr><td>pixelsAbove</td><td>${pixelsAbove.toFixed(1)}</td></tr>
                  <tr><td>pixelsBelow</td><td>${pixelsBelow.toFixed(1)}</td></tr>
                  <tr><td>bottomAdd</td><td>${bottomAdd.toFixed(1)}</td></tr>
                  <tr><td>adjustedBottomAdd</td><td>${adjustedBottomAdd.toFixed(1)}</td></tr>
                  <tr><td>scrollingDown</td><td>${scrollingDown}</td></tr>
                  <tr><td>threshold</td><td>${threshold.toFixed(1)}</td></tr>
                </table>
            `;
            drawDebugLine();
        }

        lastKnownScrollPosition = scrollTop;
    }

    function drawDebugLine() {
        if (!document.body) {
            return;
        }
        const id = 'mdbook-threshold-debug-line';
        const existingLine = document.getElementById(id);
        if (existingLine) {
            existingLine.remove();
        }
        const line = document.createElement('div');
        line.id = id;
        line.style.cssText = `
            position: fixed;
            top: ${threshold}px;
            left: 0;
            width: 100vw;
            height: 2px;
            background-color: red;
            z-index: 9999;
            pointer-events: none;
        `;
        document.body.appendChild(line);
    }

    function mdbookEnableThresholdDebug() {
        thresholdDebug = true;
        updateThreshold();
        drawDebugLine();
    }

    window.mdbookEnableThresholdDebug = mdbookEnableThresholdDebug;

    // Updates which headers in the sidebar should be expanded. If the current
    // header is inside a collapsed group, then it, and all its parents should
    // be expanded.
    function updateHeaderExpanded(currentA) {
        // Add expanded to all header-item li ancestors.
        let current = currentA.parentElement;
        while (current) {
            if (current.tagName === 'LI' && current.classList.contains('header-item')) {
                current.classList.add('expanded');
            }
            current = current.parentElement;
        }
    }

    // Updates which header is marked as the "current" header in the sidebar.
    // This is done with a virtual Y threshold, where headers at or below
    // that line will be considered the current one.
    function updateCurrentHeader() {
        if (!headers || !headers.length) {
            return;
        }

        // Reset the classes, which will be rebuilt below.
        const els = document.getElementsByClassName('current-header');
        for (const el of els) {
            el.classList.remove('current-header');
        }
        for (const toggle of headerToggles) {
            toggle.classList.remove('expanded');
        }

        // Find the last header that is above the threshold.
        let lastHeader = null;
        for (const header of headers) {
            const rect = header.getBoundingClientRect();
            if (rect.top <= threshold) {
                lastHeader = header;
            } else {
                break;
            }
        }
        if (lastHeader === null) {
            lastHeader = headers[0];
            const rect = lastHeader.getBoundingClientRect();
            const windowHeight = window.innerHeight;
            if (rect.top >= windowHeight) {
                return;
            }
        }

        // Get the anchor in the summary.
        const href = '#' + lastHeader.id;
        const a = [...document.querySelectorAll('.header-in-summary')]
            .find(element => element.getAttribute('href') === href);
        if (!a) {
            return;
        }

        a.classList.add('current-header');

        updateHeaderExpanded(a);
    }

    // Updates which header is "current" based on the threshold line.
    function reloadCurrentHeader() {
        if (disableScroll) {
            return;
        }
        updateThreshold();
        updateCurrentHeader();
    }


    // When clicking on a header in the sidebar, this adjusts the threshold so
    // that it is located next to the header. This is so that header becomes
    // "current".
    function headerThresholdClick(event) {
        // See disableScroll description why this is done.
        disableScroll = true;
        setTimeout(() => {
            disableScroll = false;
        }, 100);
        // requestAnimationFrame is used to delay the update of the "current"
        // header until after the scroll is done, and the header is in the new
        // position.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // Closest is needed because if it has child elements like <code>.
                const a = event.target.closest('a');
                const href = a.getAttribute('href');
                const targetId = href.substring(1);
                const targetElement = document.getElementById(targetId);
                if (targetElement) {
                    threshold = targetElement.getBoundingClientRect().bottom;
                    updateCurrentHeader();
                }
            });
        });
    }

    // Takes the nodes from the given head and copies them over to the
    // destination, along with some filtering.
    function filterHeader(source, dest) {
        const clone = source.cloneNode(true);
        clone.querySelectorAll('mark').forEach(mark => {
            mark.replaceWith(...mark.childNodes);
        });
        dest.append(...clone.childNodes);
    }

    // Scans page for headers and adds them to the sidebar.
    document.addEventListener('DOMContentLoaded', function() {
        const activeSection = document.querySelector('#mdbook-sidebar .active');
        if (activeSection === null) {
            return;
        }

        const main = document.getElementsByTagName('main')[0];
        headers = Array.from(main.querySelectorAll('h2, h3, h4, h5, h6'))
            .filter(h => h.id !== '' && h.children.length && h.children[0].tagName === 'A');

        if (headers.length === 0) {
            return;
        }

        // Build a tree of headers in the sidebar.

        const stack = [];

        const firstLevel = parseInt(headers[0].tagName.charAt(1));
        for (let i = 1; i < firstLevel; i++) {
            const ol = document.createElement('ol');
            ol.classList.add('section');
            if (stack.length > 0) {
                stack[stack.length - 1].ol.appendChild(ol);
            }
            stack.push({level: i + 1, ol: ol});
        }

        // The level where it will start folding deeply nested headers.
        const foldLevel = 3;

        for (let i = 0; i < headers.length; i++) {
            const header = headers[i];
            const level = parseInt(header.tagName.charAt(1));

            const currentLevel = stack[stack.length - 1].level;
            if (level > currentLevel) {
                // Begin nesting to this level.
                for (let nextLevel = currentLevel + 1; nextLevel <= level; nextLevel++) {
                    const ol = document.createElement('ol');
                    ol.classList.add('section');
                    const last = stack[stack.length - 1];
                    const lastChild = last.ol.lastChild;
                    // Handle the case where jumping more than one nesting
                    // level, which doesn't have a list item to place this new
                    // list inside of.
                    if (lastChild) {
                        lastChild.appendChild(ol);
                    } else {
                        last.ol.appendChild(ol);
                    }
                    stack.push({level: nextLevel, ol: ol});
                }
            } else if (level < currentLevel) {
                while (stack.length > 1 && stack[stack.length - 1].level > level) {
                    stack.pop();
                }
            }

            const li = document.createElement('li');
            li.classList.add('header-item');
            li.classList.add('expanded');
            if (level < foldLevel) {
                li.classList.add('expanded');
            }
            const span = document.createElement('span');
            span.classList.add('chapter-link-wrapper');
            const a = document.createElement('a');
            span.appendChild(a);
            a.href = '#' + header.id;
            a.classList.add('header-in-summary');
            filterHeader(header.children[0], a);
            a.addEventListener('click', headerThresholdClick);
            const nextHeader = headers[i + 1];
            if (nextHeader !== undefined) {
                const nextLevel = parseInt(nextHeader.tagName.charAt(1));
                if (nextLevel > level && level >= foldLevel) {
                    const toggle = document.createElement('a');
                    toggle.classList.add('chapter-fold-toggle');
                    toggle.classList.add('header-toggle');
                    toggle.addEventListener('click', () => {
                        li.classList.toggle('expanded');
                    });
                    const toggleDiv = document.createElement('div');
                    toggleDiv.textContent = '❱';
                    toggle.appendChild(toggleDiv);
                    span.appendChild(toggle);
                    headerToggles.push(li);
                }
            }
            li.appendChild(span);

            const currentParent = stack[stack.length - 1];
            currentParent.ol.appendChild(li);
        }

        const onThisPage = document.createElement('div');
        onThisPage.classList.add('on-this-page');
        onThisPage.append(stack[0].ol);
        const activeItemSpan = activeSection.parentElement;
        activeItemSpan.after(onThisPage);
    });

    document.addEventListener('DOMContentLoaded', reloadCurrentHeader);
    document.addEventListener('scroll', reloadCurrentHeader, { passive: true });
})();

