# RobinhoodAirdrop, pre-implementation threat model

Date: 2026-07-30. Status: design audit completed BEFORE implementation. Every
requirement below is binding on the implementation; the Foundry test suite must
prove the invariants at the bottom.

## Spec under audit

- Standalone, non-upgradeable contract next to RobinhoodLocker v1,
  RobinhoodBurner and RobinhoodVesting.
- `Airdrop { creator, token, merkleRoot, total, remaining, maxClaims, claims,
  endTime, listURI }`
- `create(token, merkleRoot, total, maxClaims, endTime, listURI)` payable,
  `claim(id, index, account, amount, proof[])`, `sweep(id)`,
  `quote(maxClaims)` view, `isClaimed(id, index)` view.
- Recipients pull. Nothing is pushed to a wallet, by product design: the claim
  is what brings the recipient to the site.
- Fee is `min(feeBase + feePerWallet * maxClaims, MAX_FEE)`, charged at create
  only. Claims are always free of protocol fee. Launch values are zero.
- Admin may change the two fee parameters (bounded), the collector, and hand
  over admin in two steps. Admin can never reach a funded airdrop.

## Actors and trust

| Actor | May | Must never |
|---|---|---|
| Creator | create, fund, sweep after `endTime` | reach the tokens before `endTime`, or reach another airdrop's tokens |
| Recipient | claim their leaf once | claim twice, claim someone else's leaf, forge a leaf |
| Anyone | submit a claim on another's behalf (tokens still go to `account`) | redirect a claim |
| Admin | fee parameters within the cap, collector, admin handover | reach any funded airdrop, alter an existing one |
| Token contract | | (uncontrollable, largest risk surface) |

## Findings

### CRITICAL

- **K1 A tree may promise more than was deposited.** The contract cannot sum a
  Merkle tree. A creator who deposits 100 tokens but builds a tree promising
  1,000 would let early claimants drain the tokens of every other airdrop
  holding the same token, because all airdrops of one token share the
  contract's balance. This is the single most dangerous property of the design.
  **Req:** per-airdrop `remaining`, set to the deposit at create and decremented
  by every claim. A claim that would take more than `remaining` reverts. No
  airdrop can ever spend another's deposit, whatever its tree claims.

- **K2 Leaf and node hashes must not be confusable.** If an internal node hash
  can be presented as a leaf, an attacker forges a claim without being on the
  list. `abi.encode(uint256, address, uint256)` is 96 bytes and an internal
  preimage is 64, so they cannot collide today, but that safety is incidental
  rather than stated.
  **Req:** double-hash leaves,
  `keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))`,
  the OpenZeppelin convention. The guarantee then holds by construction and
  survives any later change to the leaf tuple.

- **K3 The claimed bitmap must be scoped per airdrop.** One shared bitmap would
  let index 5 of airdrop A permanently block index 5 of airdrop B.
  **Req:** `mapping(uint256 id => mapping(uint256 word => uint256))`.

- **K4 Do NOT reuse locker v1's raw `require(transfer(...))`.** It reverts on
  tokens that return nothing (the USDT pattern).
  **Req:** the safe-transfer helper used by the vesting contract, accepting
  empty returndata, for both `transferFrom` at create and `transfer` at claim.

- **K5 CEI and a shared reentrancy guard.** Mark the index claimed and decrement
  `remaining` BEFORE transferring. Vector: a hooked token re-entering during the
  balance-delta measurement at create, or during a claim.
  **Req:** one `nonReentrant` across `create`, `claim`, `sweep`,
  `withdrawFees`.

### HIGH

- **H1 Pooled per-token balances bound the guarantee.** Every airdrop of one
  token shares the contract's balance for that token. K1 stops a tree from
  overspending, but a token that rebases down, burns from holders or blacklists
  the contract still makes those airdrops unpayable.
  **Req:** document openly; rebasing tokens unsupported; the public page shows
  the token's verification status.

- **H2 Fees accrue and are pulled, never pushed.** A reverting collector must
  not be able to brick `create`. (HoodMarket L-2 lesson.)
  **Req:** fees accumulate in the contract, `withdrawFees()` by the collector
  only; no `receive()` and no `fallback()`, so stray ETH reverts and the ETH
  balance always equals `accruedFees` exactly (SweepBuyer L-1 lesson);
  `msg.value == quote(maxClaims)` exact.

- **H3 `listURI` is attacker-controlled text rendered on our pages.** A creator
  can point it at a phishing site and borrow hoodlock.tech's credibility, which
  matters more than usual: this project has already had a domain suspended.
  **Req UI:** escape it, show it as text, and only render it as a clickable
  link when it resolves to hoodlock.tech. Anything else is displayed but not
  linked.
  **Req contract:** bound its length so storing it cannot be used to grief.

- **H4 The optics attack, an airdrop that is not really an airdrop.** A creator
  can fund an airdrop, advertise it for the trust it implies, and sweep the lot
  the moment `endTime` passes. Or build a tree where one leaf, their own, holds
  99% of the total.
  **Req UI:** the deadline and the time remaining are always shown; so are the
  recipient count and the largest single allocation. A page that shows only
  "1,000,000 tokens airdropped" is misleading by omission.

- **H5 Sweep and claim must never overlap.** If both were possible at the same
  moment, a creator could sweep while a claim is in flight and the second of the
  two would fail on a balance that no longer exists.
  **Req:** claims only while `endTime == 0 || now < endTime`; sweep only when
  `endTime != 0 && now >= endTime`. The two windows are disjoint by
  construction, and `sweep` may run once, recorded in `swept`.

### MEDIUM

- **M1** Two-step admin transfer. A single-step setter bricks administration on
  a typo.
- **M2** `MAX_FEE` is a compile-time constant that no admin call can raise, and
  both `setFeeBase` and `setFeePerWallet` re-check that the resulting quote at
  `MAX_RECIPIENTS` still respects it. A cap only on the parameters is not a cap
  on the fee.
- **M3** Guards at create: `total > 0`, `merkleRoot != 0`,
  `1 <= maxClaims <= MAX_RECIPIENTS`, `token.code.length > 0`, and `endTime`
  either 0 or at least `MIN_WINDOW` (7 days) ahead. A one-hour window is the
  airdrop equivalent of the vesting H3 optics attack.
- **M4** Events sized for indexers and for the public pages:
  `AirdropCreated(id indexed, token indexed, creator indexed, merkleRoot, total,
  maxClaims, endTime, listURI)`, `Claimed(id indexed, index, account indexed,
  amount)`, `Swept(id indexed, creator indexed, amount)`.
- **M5** `maxClaims` is both what the creator pays for and the ceiling on how
  many claims succeed. Declaring fewer wallets than the tree contains is
  therefore self-defeating rather than profitable, which is what makes the fee
  enforceable without trusting anything off chain. This is a deliberate design
  property and must be documented on the page, not just in code.
- **M6** Anyone may submit a claim for any leaf; the tokens always go to the
  leaf's `account`. This is deliberate, it costs the submitter gas and benefits
  the recipient, and it leaves the door open to sponsoring gas later.

### ACCEPTED RISKS (documented, deliberate)

- Fee-on-transfer tokens are rejected at create via `require(received >= total)`
  rather than supported. Accepting them would mean the last claimants silently
  find nothing left, which is worse than a clear failure at creation.
- Rebasing tokens are unsupported for the same reason.
- `endTime == 0` makes an airdrop claimable forever and unsweepable forever. The
  creator chooses this irreversibly at create. Unclaimed tokens then stay in the
  contract permanently, which is the creator's decision to make, not ours.
- A creator can build a tree with duplicate indexes; the second leaf sharing an
  index is unclaimable. The tree is the creator's to build correctly.
- No upgrade path. Bugs are unfixable, mitigated by this audit and by the
  invariant tests acting as a deploy gate.

## Invariants the Foundry suite must prove

1. **Conservation, per airdrop.** For every id, `claimedSum + swept <= total`,
   and `remaining == total - claimedSum - swept` at all times.
2. **Isolation, across airdrops.** No sequence of claims against airdrop A can
   reduce airdrop B's `remaining`, even when both hold the same token, and even
   when A's tree promises more than A's deposit (K1).
3. **Solvency.** The contract's balance of any token is at least the sum of
   `remaining` across every airdrop holding that token.
4. **One claim per leaf.** A valid proof succeeds exactly once; the second
   attempt reverts.
5. **No forgery.** A proof for a leaf not in the tree reverts, including an
   attempt to pass an internal node as a leaf (K2).
6. **The ceiling holds.** Claim number `maxClaims + 1` reverts even with a valid
   proof.
7. **Windows are disjoint.** `sweep` reverts before `endTime` and succeeds after;
   `claim` succeeds before and reverts after; `sweep` runs at most once.
8. **No admin reach.** No sequence of admin calls changes any airdrop's
   `remaining`, `merkleRoot`, `endTime` or token balance.
9. **The fee is capped.** For every settable `feeBase` and `feePerWallet` and
   every `maxClaims` up to `MAX_RECIPIENTS`, `quote()` never exceeds `MAX_FEE`
   and never reverts.
10. **ETH accounting.** The contract's ETH balance always equals `accruedFees`.
