import { h2, h3, p, ul, table, code, info, warn, danger, doc, blog } from "../components.mjs";

export default {
  slug: "api",
  navTitle: "REST API",
  seoTitle: "HoodLock REST API Reference | Build Your Own Locking UI",
  desc: "Endpoints for building your own lock, burn and vesting interface on Robinhood Chain: config, attribution and prepared transaction intents.",
  updated: "2026-07-29",
  h1: 'REST <span class="serif">API.</span>',
  lede: "For teams that want their own interface rather than the embed widget. The API prepares transactions; the user's wallet still signs and submits them, so nothing here can move funds.",
  body: `
${h2("Base URL and format")}
${p(`All endpoints live under <code>https://hoodlock.tech/api/dev</code>, take and return JSON, and send
permissive CORS headers so they work from a browser as well as a server.`)}
${info(`<p>These routes carry <code>X-Robots-Tag: noindex</code>, which is why this page — not the JSON —
is the documented surface.</p>`)}

${h2("Authentication")}
${p(`One credential: a public API key of the form <code>pk_</code> followed by 48 hex characters. You get
it by registering a developer handle in the ${doc("embed", "developer dashboard")}.`)}
${table(["Method", "How the key is passed"], [
  ["<code>GET</code>", "query string — <code>?key=pk_…</code>"],
  ["<code>POST</code>", "a <code>key</code> field in the JSON body"],
])}
${warn(`<p><b>There is no header form.</b> The CORS policy allows <code>Content-Type</code> only, so an
<code>Authorization</code> header will be blocked on cross-origin requests. Use the query string or the
body field.</p>`)}
${info(`<p>The key is public on purpose, in the same sense as a Stripe publishable key. It credits locks to
you and does nothing else — it cannot move funds, read balances or reach admin. Claiming earnings
requires a signature from your wallet, which the key cannot produce. Embedding it in frontend source is
the intended use.</p>`)}

${h2("GET /api/dev/config")}
${p(`Everything your interface needs to build a transaction. Call it once at boot rather than hardcoding
addresses or fees — the fee is read from the contracts and can change.`)}
${code(`curl "https://hoodlock.tech/api/dev/config?key=pk_YOUR_KEY"`, "shell")}
${code(`{
  "chainId": 4663,
  "rpc": "https://rpc.mainnet.chain.robinhood.com",
  "explorer": "https://robinhoodchain.blockscout.com",
  "locker": "0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f",
  "burner": "0x6bf43ca706faa8ea46803299c191484e82280652",
  "vesting": "0x910e19bcC4bce46999994Ed7297E0Fc4431ec72E",
  "fees":    { "lock": "5000000000000000", "burn": "5000000000000000", "vesting": "5000000000000000" },
  "feesEth": { "lock": 0.005, "burn": 0.005, "vesting": 0.005 },
  "commission": 0.5,
  "code": "your-handle"
}`, "json")}
${p(`<code>feeWei</code> and <code>feeEth</code> are also present at the top level and hold the
<b>lock</b> fee; they predate the per-product fields and are kept so older integrations keep working.
Prefer <code>fees</code>. A product that is not configured on the chain returns <code>null</code>.`)}
${p(`Errors: <code>404 {"error":"unknown key"}</code>, or <code>503</code> if the database is unavailable.`)}

${h2("Transaction intents")}
${p(`Each intent validates your inputs, encodes the call and returns an unsigned transaction. You submit
it from the user's wallet.`)}
${code(`{ "to": "0x…", "data": "0x…", "value": "5000000000000000", "chainId": 4663, "note": "…" }`, "json")}
${warn(`<p>For locks and vesting the token must be approved for <code>to</code> first — the intent covers
the HoodLock call, not the ERC-20 approval. The <code>note</code> field in the response says so too.</p>`)}

${h3("POST /api/dev/lock-intent")}
${table(["Field", "Type", "Notes"], [
  ["<code>key</code>", "string", "Your API key."],
  ["<code>token</code>", "address", "The ERC-20 to lock."],
  ["<code>amount</code>", "string", "Integer string, in the token's smallest unit."],
  ["<code>unlockTime</code>", "string", "Unix seconds. Must be in the future."],
])}
${code(`curl -X POST https://hoodlock.tech/api/dev/lock-intent \\
  -H "content-type: application/json" \\
  -d '{"key":"pk_YOUR_KEY",
       "token":"0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
       "amount":"1000000000000000000000",
       "unlockTime":"1790000000"}'`, "shell")}

${h3("POST /api/dev/burn-intent")}
${p(`Fields: <code>key</code>, <code>token</code>, <code>amount</code>. Returns <code>404</code> if
burning is not configured on the chain.`)}
${danger(`Burning is irreversible. Show the user what is about to happen in your own UI — the intent
endpoint will not stop them.`)}

${h3("POST /api/dev/vesting-intent")}
${table(["Field", "Type", "Notes"], [
  ["<code>key</code>", "string", "Your API key."],
  ["<code>token</code>", "address", "The ERC-20 to vest."],
  ["<code>amount</code>", "string", "Integer string, smallest unit."],
  ["<code>beneficiary</code>", "address", "Who receives the tokens."],
  ["<code>end</code>", "string", "Unix seconds. Must be after <code>start</code>."],
  ["<code>start</code>", "string, optional", "Defaults to now."],
  ["<code>cliff</code>", "string, optional", "Defaults to <code>start</code>. Must satisfy <code>start ≤ cliff ≤ end</code>."],
])}
${p(`The contract's rules are checked here, so a schedule that would revert generally never reaches a
signature prompt.`)}
${warn(`<p><b>One case slips through.</b> This endpoint checks <code>end - start ≥ 86400</code>, while the
contract checks <code>end &gt; block.timestamp + MIN_DURATION</code>. A back-dated <code>start</code> can
satisfy the API and still revert on-chain. Validate against <code>block.timestamp</code> in your own UI.</p>`)}

${h2("POST /api/dev/attribute")}
${p(`Credits a wallet to your handle so locks it makes afterwards earn you commission. Call it when the
user connects, before they transact.`)}
${code(`curl -X POST https://hoodlock.tech/api/dev/attribute \\
  -H "content-type: application/json" \\
  -d '{"key":"pk_YOUR_KEY","wallet":"0xUSER"}'`, "shell")}
${p(`Returns <code>{"ok":true}</code>, or <code>{"ok":false,"reason":"…"}</code> with <b>HTTP 200</b> — a
refusal is an expected outcome, not an error.`)}
${table(["Reason", "Meaning"], [
  ["<code>bad-wallet</code>", "Not a valid address."],
  ["<code>already-attributed</code>", "Another partner got there first. First touch wins and is permanent."],
  ["<code>established-wallet</code>", "The wallet was already known to HoodLock before you introduced it."],
  ["<code>already-locked</code>", "The wallet has locked, burned or vested before."],
  ["<code>unknown-code</code>", "The handle behind the key no longer exists."],
])}
${info(`<p>Only genuinely new wallets count, and only actions taken after attribution. That is deliberate:
it stops a partner from claiming users who were already here. It also means calling this endpoint on
every page load is harmless — repeats are refused, not double-counted.</p>`)}

${h2("Rate limits")}
${table(["Endpoint", "Requests per minute per IP"], [
  ["<code>/api/dev/attribute</code>", "30"],
  ["<code>*-intent</code>", "60"],
])}
${p(`Over the limit returns <code>429 {"error":"rate limited"}</code>.`)}

${h2("A minimal integration")}
${code(`const cfg = await (await fetch(\`/api/dev/config?key=\${KEY}\`)).json();

// after the user connects
await fetch("https://hoodlock.tech/api/dev/attribute", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: KEY, wallet: account }),
});

// 1. approve, 2. lock
const intent = await (await fetch("https://hoodlock.tech/api/dev/lock-intent", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: KEY, token, amount, unlockTime }),
})).json();

await walletClient.sendTransaction({
  to: intent.to, data: intent.data, value: BigInt(intent.value),
});`, "javascript")}

${h2("Getting paid")}
${p(`Partners earn <b>50%</b> of the fee on every action generated by a wallet they introduced. Earnings
accrue automatically and are claimed from the developer dashboard with a wallet signature, once the
balance passes $10. The API key plays no part in that — see ${doc("embed", "the embed widget page")}.`)}
`,
  related: [
    { href: "/docs/embed", title: "Embed widget", note: "the no-code alternative" },
    { href: "/docs/contracts", title: "Contracts", note: "what the intents encode" },
    { href: "/docs/network", title: "Network", note: "RPC and indexing limits" },
  ],
};
