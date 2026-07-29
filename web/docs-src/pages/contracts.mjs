import { h2, h3, p, ul, table, code, info, warn, danger, doc, blog, cta } from "../components.mjs";

const EXP = "https://robinhoodchain.blockscout.com";
const LOCKER = "0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f";
const BURNER = "0x6bf43ca706faa8ea46803299c191484e82280652";
const VESTING = "0x910e19bcC4bce46999994Ed7297E0Fc4431ec72E";
const addr = (a) => `<a href="${EXP}/address/${a}?tab=contract"><code>${a}</code></a>`;

export default {
  slug: "contracts",
  navTitle: "Contracts",
  seoTitle: "HoodLock Contract Addresses and ABI Reference | Robinhood Chain",
  desc: "Verified addresses, functions and events for the HoodLock locker, burner and vesting contracts on Robinhood Chain, with the guarantees each one enforces.",
  updated: "2026-07-29",
  h1: 'Contract <span class="serif">reference.</span>',
  lede: "Three contracts, all deployed on Robinhood Chain and all verified on Blockscout. Read them yourself before you send anyone to them — that is the point of publishing the addresses.",
  body: `
${h2("Addresses")}
${table(["Contract", "Address", "Purpose"], [
  ["Locker", addr(LOCKER), "Holds ERC-20 tokens until a date"],
  ["Burner", addr(BURNER), "Sends tokens to the dead address, on the record"],
  ["Vesting", addr(VESTING), "Releases tokens gradually to a beneficiary"],
])}
${p(`All three are verified, so the source you read on Blockscout is the bytecode that runs. The network
parameters are on the ${doc("network", "network page")}.`)}

${info(`None of these contracts has a function that lets us move your tokens. That is a property of the
code, not a promise — the section on each contract below points at the specific functions to check.`)}

${h2("Locker")}
${p(`One vault, many locks. Each lock records an owner, a token, an amount and an unlock time.`)}

${h3("Functions")}
${table(["Function", "Notes"], [
  ["<code>lock(address token, uint256 amount, uint256 unlockTime)</code> <b>payable</b>",
   "Returns the new lock id. Requires <code>msg.value >= fee</code>, a non-zero token, a positive amount and a future unlock time. <b>Excess ETH is refunded.</b>"],
  ["<code>withdraw(uint256 id)</code>",
   "Only the lock's owner, only once, and only at or after <code>unlockTime</code>."],
  ["<code>extend(uint256 id, uint256 newUnlockTime)</code>",
   "Requires <code>newUnlockTime &gt; unlockTime</code>. A lock can be pushed further out but <b>never pulled in</b>."],
  ["<code>transferLockOwnership(uint256 id, address newOwner)</code>",
   "Moves the right to withdraw. The tokens do not move."],
  ["<code>locks(id)</code>, <code>lockedAmount(id)</code>, <code>isUnlocked(id)</code>, <code>timeRemaining(id)</code>",
   "Views. <code>lockedAmount</code> returns 0 once withdrawn."],
  ["<code>locksByOwner(address)</code>, <code>locksByToken(address)</code>, <code>totalLocks()</code>",
   `Enumeration, used by ${doc("lock-explorer", "the explorer")} and by proof pages.`],
])}

${h3("Events")}
${code(`event Locked(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint256 unlockTime);
event Withdrawn(uint256 indexed id, address indexed owner, uint256 amount);
event Extended(uint256 indexed id, uint256 newUnlockTime);
event LockOwnershipTransferred(uint256 indexed id, address indexed from, address indexed to);`, "solidity")}

${h3("What the code guarantees")}
${ul([
  "Locked tokens can only be withdrawn by the lock's owner, and only at or after the unlock time.",
  "There is no admin function that can move locked tokens.",
  "<code>unlockTime</code> can only ever be extended.",
  "The amount recorded is measured as the balance the contract actually gained, so a fee-on-transfer token is not over-credited.",
])}
${warn(`The locker has <b>no hard cap on the fee</b>. The admin can change it, and a change applies to new
locks only — an existing lock is never re-priced. The vesting contract does have a cap; see below.`)}
${warn(`<p><b>Balance-delta accounting has a blind spot.</b> It measures what the contract gained, which is
not the same as what <i>you</i> sent. On a reflection token — where holders are credited during other
people's transfers — a deposit can be recorded above or below what actually left your wallet, because
rewards earned by the existing pool land inside the same measurement window.</p>
<p>There is also one balance pool per token, not one per lock. If a token's balances can move without a
transfer — a negative rebase, an owner burn, a blacklist zeroing — the pool can end up smaller than the
sum of what it owes. Withdrawal is all-or-nothing and first-come-first-served, so the shortfall falls
entirely on whoever withdraws last. <b>Rebasing and reflection tokens are not supported, and nothing in
the contract enforces that.</b></p>`)}

${h2("Burner")}
${p(`A burn registry rather than a vault. Tokens are moved from your wallet to the dead address in a
single transfer and never rest in the contract.`)}

${table(["Function", "Notes"], [
  ["<code>burn(address token, uint256 amount)</code> <b>payable</b>",
   "<code>transferFrom(msg.sender, DEAD, amount)</code> in one hop. Returns the burn id. Excess ETH is refunded."],
  ["<code>DEAD()</code>", "<code>0x000000000000000000000000000000000000dEaD</code>"],
  ["<code>burns(id)</code>, <code>burnsByBurner</code>, <code>burnsByToken</code>", "Views."],
  ["<code>totalBurnedOf(address token)</code>", "Cumulative amount burned through this contract for one token."],
])}
${code(`event Burned(uint256 indexed id, address indexed burner, address indexed token, uint256 amount);`, "solidity")}
${danger(`<p>Nothing in this contract can move tokens back out of the dead address, and no key controls
that address. From HoodLock's side a burn is final. Read
${blog("burning-vs-locking-liquidity", "burning versus locking")} before choosing it.</p>`)}
${warn(`<p><b>The token can still undo it.</b> Sending to the dead address parks tokens there; it does not
reduce <code>totalSupply</code>. A token that is mintable can re-issue the same amount, and an upgradeable
token can add a function that moves the dead address's balance. Neither is detectable from here.</p>
<p>The same limitation applies to <code>totalBurnedOf</code>: it is derived from the token's own
<code>balanceOf</code> readings, so a token that reports whatever it likes produces a burn record that
looks legitimate. Check whether the token is mintable or upgradeable before treating a burn total as
supply reduction.</p>`)}

${h2("Vesting")}
${p(`Linear release with an optional cliff. There is no revoke, no sweep and no rescue function in this
contract, so no HoodLock function can cancel or alter a schedule once it exists.`)}
${warn(`<p><b>“Irrevocable” describes this contract, not the token.</b> A token that is upgradeable,
pausable, mintable, or that can blacklist an address, can still make a schedule worthless or unclaimable
after the fact — and the schedule's creator is very often the token's deployer, which means they may
retain exactly that power.</p>
<p>The reverse also holds: because there is no rescue path, a token that is paused or that freezes the
beneficiary locks the tokens <b>permanently</b>, with no recourse from anyone. Irrevocable and
unrecoverable are the same property.</p>`)}

${table(["Function", "Notes"], [
  ["<code>create(address token, address beneficiary, uint256 amount, uint64 start, uint64 cliff, uint64 end)</code> <b>payable</b>",
   "Requires <code>start &lt;= cliff &lt;= end</code>, <code>end &gt; start</code>, and <code>end &gt; block.timestamp + MIN_DURATION</code>."],
  ["<code>createMany(...)</code>", "Batch, up to <code>MAX_BATCH</code> beneficiaries. Requires <code>msg.value == fee * n</code>."],
  ["<code>claim(uint256 id)</code>", "Beneficiary only. <b>Claiming is free</b> — the fee is charged once, at creation."],
  ["<code>claimable(uint256 id)</code>", "0 before the cliff; linear between cliff and end; the exact remainder at end, so nothing is left as dust."],
  ["<code>transferBeneficiary(uint256 id, address newBeneficiary)</code>", "Current beneficiary only."],
])}

${h3("Constants")}
${table(["Constant", "Value", "What it protects"], [
  ["<code>MAX_FEE</code>", "0.05 ETH", "A hard ceiling the admin can never exceed."],
  ["<code>MIN_DURATION</code>", "24 hours", "Stops a schedule that would be fully vested on arrival."],
  ["<code>MAX_BATCH</code>", "200", "Bounds gas on <code>createMany</code>."],
])}

${warn(`<p><b>The exact-fee rule differs from the other two contracts.</b> <code>create</code> requires
<code>msg.value == fee</code> exactly and has no refund path, while the locker and burner accept an
overpayment and refund the difference. Read the fee immediately before building the transaction rather
than caching it.</p>`)}

${info(`<p><b>A validation gap worth knowing about.</b> The REST API checks that
<code>end - start &gt;= 86400</code>, but the contract checks <code>end &gt; block.timestamp +
MIN_DURATION</code>. A schedule with a back-dated <code>start</code> can satisfy the API and still revert
on-chain. If you build your own UI, check against <code>block.timestamp</code>, not against
<code>start</code>.</p>`)}

${code(`event VestingCreated(uint256 indexed id, address indexed token, address indexed beneficiary,
                     address creator, uint256 total, uint64 start, uint64 cliff, uint64 end);
event Claimed(uint256 indexed id, address indexed beneficiary, uint256 amount);
event BeneficiaryTransferred(uint256 indexed id, address indexed from, address indexed to);`, "solidity")}

${h2("Administration")}
${p(`Across all three contracts the admin can change only the fee, the fee collector and the admin key.
No admin function reads or moves user tokens.`)}
${ul([
  "Locker and burner forward the fee per transaction. Vesting accrues fees in-contract and the collector pulls them with <code>withdrawFees()</code>.",
  "Vesting uses a <b>two-step admin transfer</b> — <code>transferAdmin</code> then <code>acceptAdmin</code> — so a mistyped address cannot strand the role.",
])}
${p(`How to confirm any of this yourself is covered in ${doc("security", "the security model")}, and reading
a contract on the explorer is covered in ${blog("how-to-verify-a-token-contract-on-blockscout", "this walkthrough")}.`)}
`,
  related: [
    { href: "/docs/network", title: "Network", note: "chain id, RPC and explorer" },
    { href: "/docs/api", title: "REST API", note: "build your own interface" },
    { href: "/docs/security", title: "Security model", note: "what the code does and does not allow" },
    { href: "/blog/custodial-vs-non-custodial-locking", title: "Custodial vs non-custodial locking" },
  ],
};
