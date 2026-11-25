// rex-extensions: three slides, each a simulated Rex window that installs one extension and then uses it.
// A slide's simulation is a function of one clock, elapsed: every frame shows what the window holds at that time,
// so pausing, seeking to the last frame (reduced motion) and the progress bar all read the same clock.
// The clock runs unless the visitor paused it (Autoplay off, or Space) or the tab is hidden. When a slide's
// simulation ends, the show moves on only with Autoplay on and nothing holding the slide: a mouse over the text,
// keyboard focus in the slide or on a tick, the open credits, or a recent touch or scroll (WCAG 2.2.2).
(() => {
  "use strict";

  const SWIPE = 48; // px of horizontal travel that counts as a swipe
  const TOUCH_HOLD = 5000; // ms the show stays put after the last touch or scroll in the text

  const slides = JSON.parse(document.getElementById("slides").textContent);
  const byId = (id) => document.getElementById(id);
  const stage = byId("stage");
  const dots = byId("dots");
  const progress = byId("progress");
  const toggle = byId("autoplay");
  const announce = byId("announce");
  const copyStatus = byId("copy-status");
  const current = byId("current");
  const credits = byId("credits");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const HOME = "~/.config/rex/rex-extensions";
  const INIT = "/Users/you/.config/rex/init.lua";

  // --- the scenes ------------------------------------------------------------------------------------
  // Markup: data-show="a-b" shows an element from a ms until b ms (b optional), data-on="a" adds the class on
  // from a ms, data-cur="a-b" adds the class cur from a until b. A <pre data-term="id"> is a shell, typed from the
  // scene's terms[id]: each entry appears at its at; a prompt entry types its cmd from typeAt, one character
  // every speed ms; the cursor sits after the last entry shown when that is a prompt.

  const win = (title, side, main) => '<div class="win" aria-hidden="true">' +
    '<div class="win-bar"><i></i><i></i><i></i><b>' + title + '</b></div>' +
    '<div class="win-body"><div class="side">' + side + '</div><div class="main">' + main + '</div></div></div>';
  const keys = (range, ...caps) => '<div class="keys" data-show="' + range + '">' + caps.map((k) => '<kbd>' + k + '</kbd>').join("") + '</div>';

  const issue = (n, title, who, tag, age, cls = "") =>
    '<div class="item ' + cls + '"><div class="t">● ' + title + '</div>' +
    '<div class="m"><span class="grow-x">#' + n + ' · ' + who + ' · ' + tag + '</span><span>' + age + '</span></div>';

  const SCENES = {
    github: {
      html: win("Rex · simulated",
        '<div class="sess">api</div><div class="tab cur">api · zsh</div>',
        '<div class="panes">' +
          '<div class="pane"><pre class="tx" data-term="sh"></pre></div>' +
          '<div class="pane grow agent" data-on="11000"><div class="plabel">resolve-42</div><pre class="tx" data-term="agent"></pre></div>' +
          '<div class="pane grow gh" data-on="6800">' +
            '<div class="gh-head">you/api <span>↻ ↗</span></div>' +
            '<div class="gh-labels">☑ Auto-pilot · ⚙ Settings · ↻ Refresh · ↗ GitHub</div>' +
            '<div class="rule"></div>' +
            '<div class="switch"><span data-cur="0-9000">Pull requests 2</span><span data-cur="9000">Issues 3</span></div>' +
            '<div class="rule"></div>' +
            '<div data-show="0-9000">' +
              issue(51, "Retry uploads after a timeout", "sam", "fix/upload-retry", "✓ 2h", "cur") +
                '<div class="btns"><span class="btn">Review #51</span><span class="btn">Merge #51</span></div></div>' +
              issue(50, "Run CI on Node 22", "lee", "ci/node-22", "✓ 1d") +
                '<div class="btns"><span class="btn">Review #50</span><span class="btn">Merge #50</span></div></div>' +
            '</div>' +
            '<div data-show="9000">' +
              issue(42, "Export fails on files over 2 GB", "maya", "bug", "3h", "cur") +
                '<div class="btns"><span class="btn" data-on="10200">Resolve #42</span><span class="btn">Close #42</span></div></div>' +
              issue(39, "Dark mode for the settings page", "sam", "enhancement", "2d") +
                '<div class="btns"><span class="btn">Resolve #39</span><span class="btn">Close #39</span></div></div>' +
              issue(37, "Document the export API", "lee", "docs", "4d") +
                '<div class="btns"><span class="btn">Resolve #37</span><span class="btn">Close #37</span></div></div>' +
            '</div>' +
            '<div class="hints" data-show="0-9000">↑↓ select · ⏎ open · ⇥ switch · a review #51 · q close</div>' +
            '<div class="hints" data-show="9000">↑↓ select · ⏎ open · ⇥ switch · a resolve #42 · q close</div>' +
          '</div>' +
        '</div>' +
        keys("5900-7300", "⌘", "⇧", "G") + keys("8300-9000", "⇥") + keys("9900-10700", "a")),
      terms: {
        sh: [
          { at: 0, prompt: "~/code/api $ ", cmd: "git clone https://github.com/luongnv89/rex-extensions " + HOME, typeAt: 500, speed: 22 },
          { at: 2700, text: "Cloning into '/Users/you/.config/rex/rex-extensions'...", cls: "dim" },
          { at: 3100, prompt: "~/code/api $ ", cmd: "node " + HOME + "/github/install.js", typeAt: 3400, speed: 28 },
          { at: 5000, text: "PR and issue panel on cmd+shift+g: added to " + INIT + " (backup: init.lua.bak-rex-github)" },
          { at: 5300, prompt: "~/code/api $ " },
        ],
        agent: [
          { at: 11000, text: "Claude Code", cls: "hi" },
          { at: 11000, text: " " },
          { at: 11400, prompt: "> ", cmd: "/issue-resolver 42", typeAt: 11400, speed: 30 },
          { at: 12500, text: "✻ Working on issue #42…", cls: "dim" },
        ],
      },
    },

    mcc: {
      html: win("Rex · simulated",
        '<div class="sess">api</div><div class="tab">api · claude</div><div class="tab cur">api · zsh</div>',
        '<div class="panes">' +
          '<div class="pane"><pre class="tx" data-term="sh"></pre></div>' +
        '</div>' +
        '<div class="strip" data-on="4800"><pre class="tx">' +
          '<span data-show="0-8800"> ▾ mcc usage                                                     updated 4m ago  ↻ refresh</span>' +
          '<span data-show="8800-9600"> ▾ mcc usage                                                   updated 4m ago  ↻ refreshing</span>' +
          '<span data-show="9600"> ▾ mcc usage                                                        updated now  ✓ updated</span>' +
          '\n<span class="dim"> cpu 12% · mem 27.0/32.0 GB · disk 822.1/926.4 GB 89% · net ↓1.2 MB/s ↑40 KB/s</span>' +
          '\n<span class="dim">' + "─".repeat(78) + '</span>' +
          '<span data-show="0-12000">' +
          '\n 1 personal  5h ░░░░░░░░░░░░░░░░   0%          wk ██░░░░░░░░░░░░░░  13%   21h57' +
          '\n <span class="hi">2 default</span>   5h █░░░░░░░░░░░░░░░   5%   3h17   wk ███░░░░░░░░░░░░░  17%   4d4h' +
          '<span data-show="0-9600">\n<span class="hi">►</span>3 work      5h ████░░░░░░░░░░░░  25%   1h27   wk ████░░░░░░░░░░░░  24%   6d0h</span>' +
          '<span data-show="9600">\n<span class="hi">►</span>3 work      5h █████░░░░░░░░░░░  31%   1h26   wk ████░░░░░░░░░░░░  25%   6d0h</span>' +
          '\n 4 api       api ██░░░░░░░░░░░░░ est. $4.60 this month of $50.00 budget (9%)' +
          '</span>' +
          '<span data-show="12000">' +
          '\n 1 personal  seen now   login —      upd now   5h —        wk 19:57' +
          '\n <span class="hi">2 default</span>   seen 1d    login —      upd now   5h 01:17    wk Sun 02:00' +
          '\n<span class="hi">►</span>3 work      seen 15m   login 6d0h   upd now   5h 23:26    wk Mon 22:00' +
          '\n 4 api       seen 1m    login —      upd —     api $4.60 of $50.00 (9%)' +
          '</span>' +
          '\n<span class="dim"> r refresh · c collapse · q close · d details</span>' +
        '</pre></div>' +
        keys("4200-5500", "⌘", "⇧", "U") + keys("8200-9000", "r") + keys("11300-12100", "d")),
      terms: {
        sh: [
          { at: 0, prompt: "~/code/api $ ", cmd: "node " + HOME + "/mcc/install.js", typeAt: 500, speed: 30 },
          { at: 2600, text: "mcc usage panel on cmd+shift+u: added to " + INIT + " (backup: init.lua.bak-rex-mcc)" },
          { at: 2900, prompt: "~/code/api $ " },
        ],
      },
    },

    sshtab: {
      html: win("Rex · simulated",
        '<div class="sess">Laptop</div>' +
        '<div class="tab" data-cur="0-5600">zsh</div>' +
        '<div class="tab" data-cur="5600-7600">devbox · ssh</div>' +
        '<div class="tab" data-show="7600" data-cur="7600-11000">devbox · ssh</div>' +
        '<div class="tab" data-cur="12000">project · claude</div>',
        '<div class="panes">' +
          '<div class="pane" data-show="0-5600"><pre class="tx" data-term="local"></pre></div>' +
          '<div class="pane" data-show="5600-7600"><pre class="tx" data-term="ssh"></pre></div>' +
          '<div class="pane" data-show="7600-11000"><pre class="tx" data-term="newtab"></pre></div>' +
          '<div class="pane" data-show="11000"><pre class="tx" data-term="restored"></pre></div>' +
        '</div>' +
        '<div class="blank" data-show="11000-12000">Rex restarts…</div>' +
        keys("6600-7500", "⌘", "T")),
      terms: {
        local: [
          { at: 0, prompt: "~ $ ", cmd: "node " + HOME + "/sshtab/install.js", typeAt: 500, speed: 30 },
          { at: 2700, text: "Same-machine tabs on, turned off and on with cmd+alt+t: added to " + INIT + " (backup: init.lua.bak-rex-sshtab)" },
          { at: 3000, prompt: "~ $ " },
        ],
        ssh: [
          { at: 0, prompt: "~ $ ", cmd: "ssh -p 2222 you@devbox" },
          { at: 0, text: "Last login: Tue Nov 24 09:12 from laptop", cls: "dim" },
          { at: 0, prompt: "you@devbox:~$ " },
        ],
        newtab: [
          { at: 7600, prompt: "~ $ ", cmd: "ssh -p 2222 you@devbox", typeAt: 8300, speed: 14 },
          { at: 9100, text: "Last login: Wed Nov 25 10:03 from laptop", cls: "dim" },
          { at: 9100, prompt: "you@devbox:~$ " },
        ],
        restored: [
          { at: 12000, prompt: "~/project $ ", cmd: "cd /Users/you/project && claude --resume 3f2a…", typeAt: 12900, speed: 18 },
          { at: 14200, text: " " },
          { at: 14200, text: "Claude Code", cls: "hi" },
          { at: 14200, text: "Resumed session 3f2a… in /Users/you/project", cls: "dim" },
        ],
      },
    },
  };

  // --- the clock -------------------------------------------------------------------------------------

  let index = 0;
  let autoplay = !reduceMotion.matches; // move on when a slide's simulation ends
  let frozen = false; // the visitor paused the clock
  let hoverHold = false;
  let touchUntil = 0;
  let hidden = document.hidden;
  let elapsed = 0;
  let last = null;
  let scene = null; // { update(t) } for the slide on stage
  let seeked = false; // ?t= asked for one moment, which reduced motion keeps

  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const range = (value) => {
    const [a, b] = value.split("-");
    return [Number(a), b ? Number(b) : Infinity];
  };

  // One shell at time t, as HTML.
  function termHTML(entries, t) {
    const shown = entries.filter((e) => t >= e.at);
    return shown.map((e, i) => {
      let line = "";
      if (e.prompt !== undefined) {
        line += '<span class="ps">' + esc(e.prompt) + "</span>";
        if (e.cmd) {
          const n = e.typeAt === undefined ? e.cmd.length : Math.max(0, Math.min(e.cmd.length, Math.floor((t - e.typeAt) / e.speed)));
          line += esc(e.cmd.slice(0, n));
        }
        if (i === shown.length - 1) line += '<span class="cur-blk"> </span>';
      } else {
        line += e.cls ? '<span class="' + e.cls + '">' + esc(e.text) + "</span>" : esc(e.text);
      }
      return line;
    }).join("\n");
  }

  // Builds a scene into root and returns its update(t).
  function mount(root, def) {
    root.innerHTML = def.html;
    const shows = [...root.querySelectorAll("[data-show]")].map((n) => [n, range(n.dataset.show)]);
    const ons = [...root.querySelectorAll("[data-on]")].map((n) => [n, Number(n.dataset.on)]);
    const curs = [...root.querySelectorAll("[data-cur]")].map((n) => [n, range(n.dataset.cur)]);
    const terms = [...root.querySelectorAll("[data-term]")].map((n) => [n, def.terms[n.dataset.term], ""]);
    let lastT = null;
    return (t) => {
      if (t === lastT) return;
      lastT = t;
      for (const [n, [a, b]] of shows) n.hidden = !(t >= a && t < b);
      for (const [n, a] of ons) n.classList.toggle("on", t >= a);
      for (const [n, [a, b]] of curs) n.classList.toggle("cur", t >= a && t < b);
      for (const term of terms) {
        const html = termHTML(term[1], t);
        if (html !== term[2]) { term[0].innerHTML = html; term[2] = html; }
      }
    };
  }

  // --- the text panel ----------------------------------------------------------------------------------

  function commandLines(command) {
    const pre = el("pre");
    command.split("\n").forEach((line) => {
      const row = el("span", "line");
      const glyph = el("span", "ps", "$ ");
      glyph.setAttribute("aria-hidden", "true");
      row.append(glyph, line);
      pre.append(row);
    });
    return pre;
  }

  function selectText(node) {
    const r = document.createRange();
    r.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(r);
  }

  function copyButton(what, text, source) {
    const button = el("button", "copy", "Copy");
    button.type = "button";
    button.setAttribute("aria-label", "Copy the " + what);
    let timer;
    button.addEventListener("click", async () => {
      let shown;
      try {
        await navigator.clipboard.writeText(text);
        shown = "Copied";
        copyStatus.textContent = "Copied the " + what + ".";
      } catch {
        selectText(source);
        shown = "Selected";
        copyStatus.textContent = "The " + what + " is selected: copy it with your keyboard.";
      }
      button.textContent = shown;
      clearTimeout(timer);
      timer = setTimeout(() => { button.textContent = "Copy"; }, 2000);
    });
    return button;
  }

  function box(className, label, body, what, text) {
    const section = el("section", "box " + className);
    const head = el("div", "box-head");
    head.append(el("span", "label", label), copyButton(what, text, body));
    section.setAttribute("aria-label", label);
    section.append(head, body);
    return section;
  }

  function matFor(slide) {
    const mat = el("div", "mat");
    const rig = el("div", "rig");
    const frame = el("div", "frame");
    frame.setAttribute("role", "img");
    frame.setAttribute("aria-label", slide.alt);
    const update = mount(frame, SCENES[slide.scene]);
    const steps = el("ol", "steps");
    slide.steps.forEach((step, i) => {
      const li = el("li");
      li.innerHTML = step.label; // trusted: the page's own slide data
      const end = i + 1 < slide.steps.length ? slide.steps[i + 1].at : "";
      li.dataset.on = String(step.at);
      li.dataset.cur = step.at + "-" + end;
      steps.append(li);
    });
    const stepOns = [...steps.children].map((li) => [li, Number(li.dataset.on), range(li.dataset.cur)]);
    rig.append(frame, steps);
    mat.append(rig);
    return {
      mat,
      update(t) {
        update(t);
        for (const [li, a, [c, d]] of stepOns) {
          li.classList.toggle("on", t >= a);
          li.classList.toggle("cur", t >= c && t < d);
        }
      },
    };
  }

  function render() {
    const slide = slides[index];
    const article = el("article", "slide");
    article.setAttribute("aria-roledescription", "slide");
    article.setAttribute("aria-label", (index + 1) + " of " + slides.length + ": " + slide.title);

    const inner = el("div", "panel-inner");
    const prompt = el("p", null, slide.prompt);
    inner.append(
      el("p", "group", slide.group),
      el("h2", "title", slide.title),
      el("p", "blurb", slide.blurb),
      box("cmd", "Install", commandLines(slide.command), "install command", slide.command),
      box("ask", "Ask your agent", prompt, "prompt", slide.prompt),
    );
    const panel = el("div", "panel");
    panel.append(inner);
    const built = matFor(slide);
    scene = built;
    article.append(built.mat, panel);
    const hadFocus = stage.contains(document.activeElement);
    stage.replaceChildren(article);
    if (hadFocus) {
      const heading = article.querySelector(".title");
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    // Reduced motion: the last frame, the extension in use, with nothing moving.
    if (reduceMotion.matches && !autoplay && !seeked) elapsed = slide.duration;
    scene.update(elapsed);
  }

  // The button shows pause whenever something moves: the show advancing, or a simulation still playing.
  const moving = () => !frozen && (autoplay || elapsed < slides[index].duration);

  function sync() {
    toggle.setAttribute("aria-pressed", String(moving()));
    stage.classList.toggle("frozen", frozen);
    current.textContent = pad(index + 1);
    dots.querySelectorAll(".dot").forEach((dot, i) => {
      if (i === index) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
      dot.tabIndex = i === index ? 0 : -1;
    });
  }

  // Manual navigation turns Autoplay off, as on printer-cli's site, but lets the new slide's simulation play
  // once: a slide frozen on its first frame would show an empty terminal.
  function go(to, manual) {
    index = (to + slides.length) % slides.length;
    elapsed = 0;
    seeked = false;
    if (manual) {
      autoplay = false;
      frozen = false;
      announce.textContent = "Slide " + (index + 1) + " of " + slides.length + ": " + slides[index].title;
    }
    render();
    sync();
  }

  function toggleAutoplay() {
    if (moving()) { autoplay = false; frozen = true; } else { autoplay = true; frozen = false; }
    sync();
  }

  const holdsFocus = (node) => (stage.contains(node) && node.tabIndex >= 0) || dots.contains(node);
  const focusHold = () => holdsFocus(document.activeElement) && document.activeElement.matches(":focus-visible");
  const held = (now) => hoverHold || focusHold() || credits.open || now < touchUntil;

  function tick(now) {
    const duration = slides[index].duration;
    if (!frozen && !hidden && elapsed < duration) {
      if (last !== null) elapsed = Math.min(duration, elapsed + now - last);
      last = now;
    } else {
      last = null;
    }
    if (elapsed >= duration && autoplay && !frozen && !hidden && !held(now)) go(index + 1, false);
    const pressed = String(moving());
    if (toggle.getAttribute("aria-pressed") !== pressed) toggle.setAttribute("aria-pressed", pressed);
    scene.update(elapsed);
    progress.style.transform = "scaleX(" + Math.min(elapsed / slides[index].duration, 1) + ")";
    requestAnimationFrame(tick);
  }

  slides.forEach((slide, i) => {
    const dot = el("button", "dot");
    dot.type = "button";
    dot.setAttribute("aria-label", "Go to slide " + (i + 1) + ": " + slide.title);
    dot.addEventListener("click", () => go(i, true));
    dots.append(dot);
  });
  byId("total").textContent = pad(slides.length);

  byId("prev").addEventListener("click", () => go(index - 1, true));
  byId("next").addEventListener("click", () => go(index + 1, true));
  toggle.addEventListener("click", toggleAutoplay);

  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : document.body;
    const key = event.key;
    const onDots = dots.contains(target);
    if (key === "Escape" && credits.open) {
      const inside = credits.contains(document.activeElement);
      credits.open = false;
      if (inside) credits.querySelector("summary").focus();
    } else if (onDots && (key === "Home" || key === "End")) {
      if (credits.open) return;
      event.preventDefault();
      go(key === "Home" ? 0 : slides.length - 1, true);
      dots.children[index].focus();
    } else if (key === " ") {
      if (target.closest("button, a, input, select, textarea, summary, [contenteditable], .credits-panel")) return;
      event.preventDefault();
      toggleAutoplay();
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      if (credits.open || target.closest("input, textarea, select, .credits")) return;
      event.preventDefault();
      go(index + (key === "ArrowRight" ? 1 : -1), true);
      if (onDots) dots.children[index].focus();
    }
  });
  credits.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && !credits.contains(event.relatedTarget)) credits.open = false;
  });
  document.addEventListener("focusin", (event) => {
    if (credits.open && !(event.target instanceof Node && credits.contains(event.target))) credits.open = false;
  });
  document.addEventListener("click", (event) => {
    if (credits.open && !(event.target instanceof Node && credits.contains(event.target))) credits.open = false;
  });

  stage.addEventListener("pointerover", (event) => {
    if (event.pointerType === "mouse") hoverHold = Boolean(event.target.closest(".panel"));
  });
  stage.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") hoverHold = false; });
  const hold = (event) => {
    if (event.target instanceof Element && event.target.closest(".panel")) touchUntil = performance.now() + TOUCH_HOLD;
  };
  stage.addEventListener("touchstart", hold, { passive: true });
  stage.addEventListener("touchmove", hold, { passive: true });
  stage.addEventListener("scroll", hold, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    hidden = document.hidden;
    last = null;
  });
  reduceMotion.addEventListener("change", () => {
    if (reduceMotion.matches) { autoplay = false; elapsed = slides[index].duration; }
    sync();
  });

  let touch = null;
  stage.addEventListener("touchstart", (event) => {
    const [first] = event.touches;
    touch = event.touches.length === 1 ? { x: first.clientX, y: first.clientY } : null;
  }, { passive: true });
  stage.addEventListener("touchend", (event) => {
    if (!touch) return;
    const dx = event.changedTouches[0].clientX - touch.x;
    const dy = event.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > 1.5 * Math.abs(dy)) go(index + (dx < 0 ? 1 : -1), true);
  }, { passive: true });

  // ?slide=2&t=9000 opens a slide at a moment of its simulation, paused: for screenshots and links to a step.
  const params = new URLSearchParams(location.search);
  if (params.has("slide")) {
    index = Math.max(0, Math.min(slides.length - 1, Number(params.get("slide")) - 1 || 0));
    if (params.has("t")) { elapsed = Math.min(slides[index].duration, Number(params.get("t")) || 0); autoplay = false; frozen = true; seeked = true; }
  }
  render();
  sync();
  requestAnimationFrame(tick);
})();
