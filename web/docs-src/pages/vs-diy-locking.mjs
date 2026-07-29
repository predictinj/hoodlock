import { h2, p, ul, table, code, info, warn, doc, blog, cta } from "../components.mjs";

export default {
  slug: "vs/diy-locking",
  navTitle: "vs locking it yourself",
  seoTitle: "Writing Your Own Lock Contract vs Using HoodLock",
  desc: "Locking tokens yourself is a twenty-line contract. An honest look at when that is the right call and what the twenty lines leave you to build afterwards.",
  updated: "2026-07-29",
  h1: 'Rolling your <span class="serif">own.</span>',
  lede: "A timelock is twenty lines, and we will not pretend otherwise. The contract was never the hard part — everything that has to exist around it is, and that is where an afternoon turns into ongoing maintenance nobody budgeted for.",
  body: `
${h2("The part that is easy")}
${p(`A single-beneficiary timelock is short enough to read in one screen, and there is nothing clever in it.`)}
${code(`contract Timelock {
    address public immutable owner;
    IERC20  public immutable token;
    uint256 public immutable unlockTime;

    constructor(address t, uint256 u) { owner = msg.sender; token = IERC20(t); unlockTime = u; }

    function withdraw() external {
        require(msg.sender == owner, "not owner");
        require(block.timestamp >= unlockTime, "locked");
        token.transfer(owner, token.balanceOf(address(this)));
    }
}`, "solidity")}
${p(`If your team writes Solidity, deploying this is an afternoon including tests. Anyone claiming the
mechanism itself is hard is selling something.`)}

${h2("The part that is not")}
${p(`The contract is the smallest component of the job. What follows is the rest of it.`)}
${table(["What you still need", "Why it is not optional"], [
  ["<b>Verified source on the explorer</b>", "An unverified lock contract proves nothing to anyone. If they cannot read it, they cannot check it."],
  ["<b>A page a non-technical holder can read</b>", "Most of the people you are reassuring cannot read a contract. A link to a raw address does not do the job."],
  ["<b>Correct handling of odd tokens</b>", "Fee-on-transfer tokens deposit less than you sent. Tokens that return no boolean break naive transfers. Both are common."],
  ["<b>An extend path</b>", "Without one you have to withdraw and re-lock, which creates exactly the gap a lock exists to avoid."],
  ["<b>Ongoing discoverability</b>", "A bespoke contract appears in no explorer, no aggregator and no directory. Nobody finds it unless you tell them."],
  ["<b>Credibility of a contract only you have seen</b>", "A one-off address is precisely the shape a fake lock takes. Yours is real; it looks the same from outside."],
])}
${warn(`<p>That last row is the one teams underestimate. A custom lock contract asks holders to audit your
code before they can trust your commitment, which is a larger ask than the commitment itself, and most of
them will simply decline.</p>`)}

${h2("The narrow case for building it")}
${p(`It is worth naming honestly, because it is narrower than it first looks.`)}
${ul([
  "<b>You need logic no general locker has.</b> Multi-sig release, oracle conditions, milestone-gated unlocks, governance-controlled schedules.",
  "<b>The asset is not an ERC-20.</b> An NFT position, a staked receipt or a bespoke token standard needs a contract built for it.",
  "<b>You are locking at a scale where a per-lock fee actually matters.</b> At a large enough count, deployment amortises.",
  "<b>Your team already ships audited Solidity</b> and the lock is a small addition to an existing system you maintain anyway.",
])}

${h2("Where the reasoning usually breaks down")}
${ul([
  "<b>To save the fee.</b> A flat 0.005 ETH against an afternoon of engineering plus indefinite maintenance is not a close call.",
  "<b>Because a general locker feels like a dependency.</b> It is not one — the contracts run without our site, and you can call <code>withdraw</code> from a block explorer if hoodlock.tech vanishes entirely.",
  "<b>Because you want control.</b> A lock exists to <i>remove</i> your control. A contract you wrote and could redeploy reads as less binding, not more.",
])}
${info(`<p>That third point is the counterintuitive one. The value of using a shared, public, verified
locker is precisely that you did not write it. Nobody has to consider whether you left yourself a door.
${doc("security", "The security model")} names the functions to check, and they are the same functions on
every lock we hold.</p>`)}

${h2("What most teams land on")}
${p(`Lock the ordinary balances — creator supply, treasury, LP — where they are discoverable and checkable
without effort, and reserve bespoke contracts for the rare case that genuinely needs logic nothing offers.
Teams that start by building their own almost always end up wanting a shared, public locker for the
straightforward cases anyway, because that is where the credibility comes from rather than the mechanics.`)}

${h2("What you would be comparing against")}
${table(["", "Your own contract", "HoodLock"], [
  ["Cost", "Engineering time, then gas", "0.005 ETH flat, plus gas"],
  ["Verification", "Yours to do", "Verified on Blockscout"],
  ["Public proof page", "Yours to build", "Generated per record"],
  ["Extend without a gap", "Yours to implement", "Built in, free"],
  ["Fee-on-transfer safety", "Yours to handle", "Records the balance gained; rebasing tokens unsupported"],
  ["Discoverable by strangers", "No", doc("lock-explorer", "In the explorer")],
  ["Custom release logic", "<b>Anything you write</b>", "Linear vesting, or a single date"],
])}
${p(`${blog("how-to-choose-a-token-locker", "How to choose a token locker")} covers the criteria to apply
to any option, including this one.`)}

${cta("Skip the afternoon of engineering", "Flat 0.005 ETH per lock, a verified contract you did not have to write, and a proof page generated for you.")}
`,
  related: [
    { href: "/docs/contracts", title: "Contracts", note: "what ours actually do" },
    { href: "/docs/security", title: "Security model" },
    { href: "/docs/api", title: "REST API", note: "if you want your own interface, not your own contract" },
    { href: "/blog/custodial-vs-non-custodial-locking", title: "Custodial vs non-custodial locking" },
  ],
};
