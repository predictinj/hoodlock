import { h2, h3, p, ul, table, code, info, warn, doc, blog } from "../components.mjs";

export default {
  slug: "security",
  navTitle: "Security model",
  seoTitle: "HoodLock Security Model | What the Contracts Can and Cannot Do",
  desc: "Non-custodial by construction: what admin can reach, what it cannot, the fee caps, and how to verify every claim on this page yourself.",
  updated: "2026-07-29",
  h1: 'Security <span class="serif">model.</span>',
  lede: "The useful question is not whether we would take your tokens. It is whether the code lets us. Everything below points at a function you can read rather than a promise you have to accept.",
  body: `
${h2("Non-custodial, precisely")}
${p(`The locker and the vesting contract hold tokens. That is custody in the literal sense, so the claim
worth making is narrower and checkable: <b>no function exists that lets anyone other than the rightful
party withdraw them.</b>`)}
${table(["Contract", "Who can move tokens out", "Under what condition"], [
  ["Locker", "The lock's owner, and nobody else", "At or after the unlock time"],
  ["Vesting", "The beneficiary, and nobody else", "As the schedule releases"],
  ["Burner", "Nobody — ever", "Tokens go straight to the dead address and never rest in the contract"],
])}
${info(`<p>Note the absence rather than the presence. There is no <code>rescue</code>, no
<code>sweep</code>, no <code>emergencyWithdraw</code> and no pause that redirects funds. A backdoor you
cannot find is usually a backdoor that is not there, and you can check, because all three contracts are
verified on Blockscout.</p>`)}

${h2("What admin can actually do")}
${p(`Each contract has an admin key. Its reach is deliberately narrow.`)}
${table(["Admin can", "Admin cannot"], [
  ["Change the fee for <b>new</b> records", "Touch any existing lock, schedule or balance"],
  ["Change the fee collector address", "Withdraw, redirect or freeze user tokens"],
  ["Transfer the admin role", "Alter an unlock date or a vesting schedule"],
])}
${warn(`<p>Two asymmetries worth knowing rather than discovering:</p>
<ul>
<li><b>Vesting has a hard fee cap of 0.05 ETH</b>, written as a contract constant. No admin action can
exceed it.</li>
<li><b>The locker and burner have no such cap.</b> The admin can set any fee for new records. Existing
locks are never re-priced and withdrawal is always free, but the ceiling is not enforced in code.</li>
</ul>`)}
${p(`The vesting contract uses a <b>two-step admin transfer</b> — <code>transferAdmin</code> then
<code>acceptAdmin</code>, so a mistyped address cannot strand the role.`)}

${h2("Verify it yourself")}
${p(`This takes about five minutes and does not require trusting anything on this page.`)}
${ul([
  "Open a contract from the " + doc("contracts", "contract reference") + " — the links go straight to the verified source tab.",
  "Confirm the source is <b>verified</b>. If it were not, nothing else here could be checked.",
  "Search the source for <code>withdraw</code>. Read every match and confirm each is gated on the owner or beneficiary.",
  "Search for <code>onlyAdmin</code>. Read what those functions touch. You should find fees, the collector and the admin key, and nothing else.",
  "Check that the fee constant matches what the app charges you.",
])}
${p(`${blog("how-to-verify-a-token-contract-on-blockscout", "How to read a contract on Blockscout")} covers
the mechanics if you have not done it before.`)}

${h2("Token quirks the contracts handle")}
${table(["Quirk", "How it is handled"], [
  ["Fee-on-transfer tokens", "The amount recorded is the balance the contract actually gained. Simple fee-on-transfer is recorded correctly; <b>rebasing and reflection tokens are not supported</b> and can leave the shared per-token pool short of what it owes."],
  ["Tokens that return no boolean", "Transfers use a safe wrapper in the vesting contract rather than a raw <code>require</code>."],
  ["Overpaid fees", "Refunded by the locker and burner. <b>Not</b> by vesting, which requires the exact fee."],
  ["Non-contract token addresses", "Vesting rejects an address with no code, so a typo cannot create an empty schedule."],
])}

${h2("What this does not protect you from")}
${p(`Being clear about the boundary matters more than the reassurance.`)}
${ul([
  "<b>A malicious token contract.</b> Locking a token that can be minted at will does not constrain the minting. Read the token, not just the lock.",
  "<b>A compromised wallet.</b> If someone controls the lock owner's key, they control the lock when it expires.",
  "<b>Bad distribution.</b> A locked balance says nothing about the other 95% of supply — " + blog("how-to-read-token-holder-distribution", "check the holder list") + ".",
  "<b>Phishing.</b> We will never DM you, never ask for a seed phrase, and never ask you to “verify” a wallet. Reach the app by typing the domain.",
])}

${h2("Reporting an issue")}
${p(`If you believe you have found a vulnerability in any of the three contracts or in the site, report it
privately before disclosing it publicly. A responsible report gives us a chance to protect the people
currently using the contracts, which a public one does not.`)}
`,
  related: [
    { href: "/docs/contracts", title: "Contracts", note: "the functions this page describes" },
    { href: "/docs/fees", title: "Fees", note: "including the caps" },
    { href: "/blog/custodial-vs-non-custodial-locking", title: "Custodial vs non-custodial locking" },
    { href: "/blog/how-to-choose-a-token-locker", title: "How to choose a token locker" },
  ],
};
