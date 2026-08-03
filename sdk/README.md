# @hoodlock/sdk

Integrate HoodLock airdrops, locks, burns and vesting on Robinhood Chain
(chain id 4663) into your own platform.

The Merkle code in this package is the same module HoodLock's server runs, so
a root you compute locally is exactly the root the claim page can prove.
Nothing in the SDK holds keys: every write either returns `{ to, data, value }`
calldata for your own signer, or submits through a viem `walletClient` you
provide.

## Install

```sh
npm i viem
npm i @hoodlock/sdk        # or vendor this folder until it is on npm
```

## Fund an airdrop from your platform

```js
import { HoodLock } from "@hoodlock/sdk";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";

const chain = defineChain({ id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });

const hl = new HoodLock({
  publicClient: createPublicClient({ chain, transport: http() }),
  walletClient: yourWalletClient,   // optional: only for sendAirdrop()
});

// 1. Build the recipient list (text or structured rows). Amounts are human
//    units here; use normalize() for base-unit rows.
const list = hl.buildList(`
  0x1111111111111111111111111111111111111111 100
  0x2222222222222222222222222222222222222222 250
`, { decimals: 18 });

// 2a. Hands-off: the SDK publishes the list, approves and creates.
const { airdropCreateHash } = await hl.sendAirdrop({ token, list, deadlineDays: 30 });

// 2b. Or bring your own signer: get raw calldata instead.
const tx = await hl.createAirdropTx({ token, list, deadlineDays: 30, owner });
// sign tx.approve (when not null), then tx.create ({ to, data, value })
```

`deadlineDays: 0` means claimable forever and never sweepable. Any deadline
must be at least 7 days: the contract rejects shorter windows.

## Let your users claim

```js
const items = await hl.claimable(userAddress);   // [{ id, token, amount, … }]
const tx = await hl.claimTx({ id: items[0].id, address: userAddress });
// user signs { to, data } — tokens go to their wallet no matter who submits
```

Proofs are fetched fresh at claim time, so a stale UI can never produce a
transaction that is certain to revert. Claim pages also exist out of the box
at `hoodlock.tech/app/airdrops` if you would rather link than integrate.

## Earn commission (developer program)

Register at `hoodlock.tech/app/developers` to get a public `pk_…` key. It can
only attribute actions to you, never move funds.

```js
const hl = new HoodLock({ apiKey: "pk_…" });
await hl.attribute(connectedWallet);          // first-touch, call on connect
const lockTx = await hl.lockIntentTx({ ... }); // prepared lock calldata
```

Attributed wallets earn you 50% of the platform fee on every lock, burn and
vesting schedule they create. Airdrops are currently fee-free, so they earn
no commission until a fee is switched on.

## Contracts (verified on Blockscout)

| Contract | Address |
|---|---|
| Airdrop | `0x6B1fE7b821001144Ee74EEA258b0AafdE20102E8` |
| Locker  | `0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f` |
| Burner  | `0x6bf43ca706faa8ea46803299c191484e82280652` |
| Vesting | `0x910e19bcC4bce46999994Ed7297E0Fc4431ec72E` |

REST endpoints used: `POST /api/airdrop/list`, `GET /api/airdrop/eligible`,
`GET /api/airdrop/:id/proof`, `POST /api/dev/attribute`,
`POST /api/dev/lock-intent`. Full API docs: `hoodlock.tech/docs/api`.

## Maintainer note

`merkle.mjs` and `airdrop-list.mjs` are copies of `shared/` in the HoodLock
repo. If `shared/` changes, re-copy: a drifted root means every claim fails.
