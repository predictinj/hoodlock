/* HoodLock embed loader — drop this on any page:
 *   <script src="https://hoodlock.tech/embed.js" data-key="pk_dev_…"></script>
 *   <button data-hoodlock data-token="0x…">Lock with HoodLock</button>
 * or call window.HoodLock.open({ token, amount, unlockTime }).
 * Opens HoodLock's lock UI in a modal iframe and relays events back to the page. */
(function () {
  "use strict";
  if (window.HoodLock && window.HoodLock.__ready) return;

  var self = document.currentScript;
  var ORIGIN = (function () {
    try { return new URL(self.src).origin; } catch (e) { return "https://hoodlock.tech"; }
  })();
  var KEY = self && self.getAttribute("data-key") || "";

  var listeners = {}; // event -> [cb]
  function emit(evt, data) { (listeners[evt] || []).forEach(function (cb) { try { cb(data); } catch (e) {} }); }
  function on(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); return API; }

  var overlay = null, frame = null;

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; frame = null;
    document.documentElement.style.overflow = "";
    emit("close", {});
  }

  function open(opts) {
    opts = opts || {};
    var key = opts.key || KEY;
    if (!key) { console.error("[HoodLock] missing data-key on the embed script (or opts.key)."); return; }
    if (overlay) close();

    var params = new URLSearchParams();
    params.set("key", key);
    if (opts.token) params.set("token", opts.token);
    if (opts.unlockTime) params.set("unlockTime", String(opts.unlockTime));

    overlay = document.createElement("div");
    overlay.setAttribute("data-hoodlock-overlay", "");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(4,8,12,.72);" +
      "backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);display:flex;align-items:center;" +
      "justify-content:center;padding:16px;overflow:auto;";
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });

    frame = document.createElement("iframe");
    frame.src = ORIGIN + "/embed?" + params.toString();
    frame.setAttribute("allow", "clipboard-write; ethereum");
    frame.setAttribute("title", "Lock with HoodLock");
    frame.style.cssText = "width:100%;max-width:440px;height:520px;border:0;border-radius:16px;" +
      "box-shadow:0 30px 90px rgba(0,0,0,.6);background:transparent;transition:height .15s ease;";
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = "hidden";
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.source !== "hoodlock-embed") return;
    if (frame && e.source !== frame.contentWindow) return; // only our iframe
    if (d.type === "resize" && frame && d.height) { frame.style.height = Math.min(d.height + 4, Math.max(360, window.innerHeight - 32)) + "px"; }
    else if (d.type === "close") { close(); }
    else if (d.type === "locked") { emit("locked", d); }
    else if (d.type === "error") { emit("error", d); }
    else if (d.type === "ready") { emit("ready", d); }
    else if (d.type === "connected") { emit("connected", d); }
  });

  function wire() {
    var btns = document.querySelectorAll("[data-hoodlock]:not([data-hoodlock-wired])");
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.setAttribute("data-hoodlock-wired", "1");
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        open({ token: btn.getAttribute("data-token") || "", unlockTime: btn.getAttribute("data-unlock") || "" });
      });
    })(btns[i]);
  }

  var API = { open: open, close: close, on: on, wire: wire, __ready: true };
  window.HoodLock = API;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
