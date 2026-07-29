/* HoodLock docs runtime.
 *
 * Everything here is progressive enhancement: the sidebar, the table of
 * contents and every link work with this file blocked. Search degrades to the
 * sidebar, which is why the input is not the only way to reach a page.
 *
 * No dependencies, no build step, no framework.
 */
(function () {
  "use strict";
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- copy buttons ---------- */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-copy]");
    if (!btn) return;
    var pre = btn.parentElement.querySelector("pre");
    if (!pre) return;
    var text = pre.innerText;
    var done = function () {
      btn.textContent = "Copied";
      btn.setAttribute("data-done", "1");
      setTimeout(function () { btn.textContent = "Copy"; btn.removeAttribute("data-done"); }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      // Older mobile browsers and any non-secure context land here.
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.cssText = "position:absolute;left:-9999px";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (_) { /* leave the button alone */ }
      document.body.removeChild(ta);
    }
  });

  /* ---------- mobile sidebar ---------- */
  var sb = document.getElementById("sidebar");
  var menuBtn = document.getElementById("menuBtn");
  var backdrop = document.getElementById("sbBackdrop");
  var closeBtn = document.getElementById("sbClose");
  function setMenu(open) {
    if (!sb) return;
    sb.classList.toggle("open", open);
    if (backdrop) backdrop.hidden = !open;
    if (menuBtn) menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    document.documentElement.style.overflow = open ? "hidden" : "";
    if (open) { var f = sb.querySelector("a"); if (f) f.focus(); }
    else if (menuBtn) menuBtn.focus();
  }
  if (menuBtn) menuBtn.addEventListener("click", function () { setMenu(!sb.classList.contains("open")); });
  if (closeBtn) closeBtn.addEventListener("click", function () { setMenu(false); });
  if (backdrop) backdrop.addEventListener("click", function () { setMenu(false); });
  if (sb) sb.addEventListener("click", function (e) { if (e.target.closest("a")) setMenu(false); });

  /* The drawer covers the page behind a backdrop, so it behaves as a modal and
     owes the two things a modal owes: Escape closes it, and Tab stays inside it.
     Without the trap, tabbing walks into links the user cannot see. */
  document.addEventListener("keydown", function (e) {
    if (!sb || !sb.classList.contains("open")) return;
    if (e.key === "Escape") { e.preventDefault(); setMenu(false); return; }
    if (e.key !== "Tab") return;
    var f = sb.querySelectorAll("a[href], button:not([disabled])");
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!sb.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  });

  /* ---------- reading progress ---------- */
  var bar = document.getElementById("progress");
  if (bar && !reduced) {
    var tick = false;
    var update = function () {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      bar.style.transform = "scaleX(" + (max > 0 ? Math.min(1, h.scrollTop / max) : 0) + ")";
      tick = false;
    };
    addEventListener("scroll", function () {
      if (!tick) { tick = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  } else if (bar) bar.remove();

  /* ---------- table of contents highlight ---------- */
  var tocLinks = [].slice.call(document.querySelectorAll(".toc a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
    var seen = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { seen[en.target.id] = en.isIntersecting; });
      var current = null;
      Object.keys(byId).forEach(function (id) { if (seen[id] && !current) current = id; });
      tocLinks.forEach(function (a) {
        a.classList.toggle("on", a.getAttribute("href") === "#" + current);
      });
    }, { rootMargin: "0px 0px -70% 0px" });
    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id); if (el) io.observe(el);
    });
  }

  /* ---------- search ---------- */
  var input = document.getElementById("docsearch");
  var results = document.getElementById("docresults");
  if (!input || !results) return;

  var index = null, loading = false, active = -1;

  function load() {
    if (index || loading) return;
    loading = true;
    fetch("/docs/search.json")
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (j) { index = j; loading = false; if (input.value) run(); })
      .catch(function () { index = []; loading = false; });
  }
  input.addEventListener("focus", load, { once: true });

  function score(page, terms) {
    var t = (page.title || "").toLowerCase();
    var d = (page.desc || "").toLowerCase();
    var h = (page.headings || "").toLowerCase();
    var s = 0;
    for (var i = 0; i < terms.length; i++) {
      var q = terms[i];
      if (t.indexOf(q) === 0) s += 12;
      else if (t.indexOf(q) > -1) s += 8;
      if (d.indexOf(q) > -1) s += 3;
      if (h.indexOf(q) > -1) s += 2;
      if (t.indexOf(q) < 0 && d.indexOf(q) < 0 && h.indexOf(q) < 0) return 0; // every term must appear
    }
    return s;
  }

  function run() {
    var q = input.value.trim().toLowerCase();
    if (!q || !index) { hide(); return; }
    var terms = q.split(/\s+/);
    var hits = index.map(function (pg) { return { pg: pg, s: score(pg, terms) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, 8);
    if (!hits.length) {
      results.innerHTML = '<div class="none">No matches. Try “lock”, “vesting”, “fees” or “API”.</div>';
    } else {
      results.innerHTML = hits.map(function (x, i) {
        return '<a role="option" id="dr' + i + '" aria-selected="false" href="' + x.pg.url + '">' +
          esc(x.pg.title) + '<span class="s">' + esc(x.pg.desc) + "</span></a>";
      }).join("");
    }
    active = -1;
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function hide() {
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }
  function move(dir) {
    var links = results.querySelectorAll("a");
    if (!links.length) return;
    active = (active + dir + links.length) % links.length;
    for (var i = 0; i < links.length; i++) {
      var on = i === active;
      links[i].classList.toggle("on", on);
      links[i].setAttribute("aria-selected", on ? "true" : "false");
    }
    input.setAttribute("aria-activedescendant", links[active].id);
    links[active].scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", run);
  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      var sel = results.querySelector("a.on");
      if (sel) { e.preventDefault(); location.href = sel.href; }
    } else if (e.key === "Escape") { hide(); input.blur(); }
  });
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".search")) hide();
  });
  // "/" focuses search, the convention every docs site uses.
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault(); input.focus();
    }
  });
})();
