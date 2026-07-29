import { h2, h3, p, ul, table, code, info, warn, doc, app } from "../components.mjs";

export default {
  slug: "embed",
  navTitle: "Embed widget",
  seoTitle: "HoodLock Embed Widget | Add Token Locking to Your Site",
  desc: "Drop a lock, burn or vesting button onto your own site with one script tag, keep your own styling, and earn half the fee on what it generates.",
  updated: "2026-07-29",
  h1: 'Embed <span class="serif">widget.</span>',
  lede: "One script tag and a button. The flow opens in a modal on your page, the user signs in their own wallet, and the tokens never touch your site or ours.",
  body: `
${h2("Install")}
${p(`Include the script once, then mark any button with <code>data-hoodlock</code>. Everything except
that attribute is optional — a lock-only integration is a button with nothing else on it.`)}
${code(`<script src="https://hoodlock.tech/embed.js" data-key="pk_YOUR_KEY"></script>

<!-- lock is the default mode, so this is the whole integration -->
<button data-hoodlock>Lock tokens</button>

<!-- pre-fill the token so the user cannot pick a different one -->
<button data-hoodlock data-token="0xYourTokenAddress">Lock tokens</button>

<button data-hoodlock data-mode="burn" data-token="0xYourTokenAddress">Burn tokens</button>

<button data-hoodlock data-mode="vesting"
        data-token="0xYourTokenAddress"
        data-beneficiary="0xTeamWallet">Create vesting</button>`, "html")}
${info(`<p><code>0xYourTokenAddress</code> is a placeholder. Insert the real address from your own data
when you render the page — it is different on every token page, so it is not a literal string to paste.</p>`)}

${h2("Your button keeps your styling")}
${p(`The widget never touches how your button looks. It attaches a click handler and marks the element as
wired; it sets no classes, no inline styles and no attributes that affect appearance. Style the button
however you like — Tailwind, CSS modules, a design system component, anything.`)}
${p(`This is worth stating plainly because it is the usual objection to embedded widgets: most teams want
the functionality and their own design. Here you get both, because the only thing we render is the modal.`)}

${h2("Attributes")}
${h3("On the script tag")}
${table(["Attribute", "Required", "What it does"], [
  ["<code>data-key</code>", "yes", "Your public API key. Without it the widget logs an error and does nothing."],
  ["<code>data-attribution</code>", "no", "Set to <code>off</code> to leave out the “Secured by HoodLock” line."],
])}
${h3("On a button")}
${table(["Attribute", "Required", "What it does"], [
  ["<code>data-hoodlock</code>", "yes", "Marks the button. Nothing else is needed for a lock."],
  ["<code>data-mode</code>", "no", "<code>lock</code> (default), <code>burn</code> or <code>vesting</code>. An unrecognised value falls back to <code>lock</code>."],
  ["<code>data-token</code>", "no", "Pre-fills the token and makes the field read-only. Leave it out and the user picks from their own wallet."],
  ["<code>data-beneficiary</code>", "no", "Vesting only. Pre-fills the recipient; the user can still edit it."],
  ["<code>data-unlock</code>", "no", "Lock only. Pre-fills the unlock date as Unix seconds."],
])}

${h2("JavaScript API")}
${p(`<code>window.HoodLock</code> is available once the script has loaded.`)}
${code(`// open programmatically
HoodLock.open({ token: "0x…", unlockTime: 1790000000 });
HoodLock.open({ mode: "burn", token: "0x…" });
HoodLock.open({ mode: "vesting", token: "0x…", beneficiary: "0x…" });

// one handler for every product
HoodLock.on("done", ({ type, txHash, id, token, amount }) => {
  console.log(type, id, txHash);   // type: "locked" | "burned" | "vested"
});

// or listen per product
HoodLock.on("locked", ({ txHash, id }) => refreshMyUi(id));

HoodLock.close();   // close the modal
HoodLock.wire();    // re-scan the DOM after rendering new buttons`, "javascript")}
${info(`<p>Call <code>HoodLock.wire()</code> after any client-side render that adds buttons. It only picks
up elements it has not already wired, so calling it more than once is safe.</p>`)}

${h3("Events")}
${table(["Event", "Payload", "When"], [
  ["<code>ready</code>", "—", "The modal has loaded."],
  ["<code>connected</code>", "<code>{ account }</code>", "The user connected a wallet."],
  ["<code>locked</code> / <code>burned</code> / <code>vested</code>", "<code>{ txHash, id, token, amount }</code>", "The action succeeded."],
  ["<code>done</code>", "the same payload plus <code>type</code>", "Fires alongside each of the three above."],
  ["<code>error</code>", "<code>{ message }</code>", "Something failed. The message is already human-readable."],
  ["<code>close</code>", "—", "The modal was dismissed."],
])}
${warn(`<p>A payload can carry <code>unconfirmed: true</code>. That means the transaction was broadcast but
the receipt could not be fetched — it has most likely landed. Treat it as provisional and confirm against
the chain rather than telling the user it failed.</p>`)}
${p(`<code>id</code> is the on-chain record id and may be <code>null</code> if it could not be read back.
<code>lockId</code> is an alias kept for older integrations.`)}

${h2("The attribution line")}
${p(`The widget adds one small line after the last HoodLock button on the page:`)}
${code(`<div class="hoodlock-attribution">
  <a href="https://hoodlock.tech" rel="noopener">Secured by HoodLock</a>
</div>`, "html")}
${p(`It inherits your text colour, appears once per page regardless of how many buttons you have, and is
a plain followable link. Turn it off with <code>data-attribution="off"</code> on the script tag if it does
not suit the design.`)}

${h2("Framing and CSP")}
${p(`The modal is an iframe from <code>hoodlock.tech/embed</code>. If your site sends a
<code>Content-Security-Policy</code>, allow it:`)}
${code(`frame-src https://hoodlock.tech;
script-src https://hoodlock.tech;`, "text")}

${h2("When the user has no wallet")}
${p(`In-app browsers sometimes block wallet access inside an iframe. The widget detects that and offers a
link that opens the same flow in a new tab, with your key carried through so the action still counts as
yours. You do not need to handle it.`)}

${h2("Earnings")}
${p(`You earn <b>50%</b> of the fee on every lock, burn and vesting schedule created by a wallet you
introduced. Only genuinely new wallets count, first touch is permanent, and only actions after
attribution qualify. Claim to your wallet from ${app("developers", "the developer dashboard")} once the
balance passes $10.`)}
${p(`Prefer to build the interface yourself? The ${doc("api", "REST API")} exposes the same three products
as prepared transactions.`)}
`,
  related: [
    { href: "/docs/api", title: "REST API", note: "build your own interface instead" },
    { href: "/docs/contracts", title: "Contracts" },
    { href: "/docs/fees", title: "Fees" },
  ],
};
