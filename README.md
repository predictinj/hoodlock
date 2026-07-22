# HoodLock

The first **liquidity & token locker** on **Robinhood Chain** (chain id 4663). Lock LP tokens or any ERC-20 until a chosen date, and share a public, verifiable on-chain proof.

## Why
Robinhood Chain launched July 2026 and no established locker (UNCX, Team.Finance, PinkLock) is deployed there yet. Every token that launches on the chain needs a way to lock liquidity and prove it. HoodLock fills that gap.

## Safety model
`contracts/RobinhoodLocker.sol` is a single audited-style vault holding many locks:
- Locked tokens can **only** be withdrawn by the lock's owner, and **only** at/after its `unlockTime`.
- There is **no admin function** that can move locked tokens.
- `unlockTime` can only be **extended**, never shortened.
- Fee-on-transfer tokens are handled by recording the amount actually received.
- Reentrancy-guarded. The admin can change only the flat fee, fee collector, and admin key.

The deployed contract is **source-verified on Blockscout**, so anyone can read the code.

## Deployment (Robinhood Chain mainnet)
- **Locker contract:** see `web/src/config.json` (`locker`)
- Explorer: https://robinhoodchain.blockscout.com

## Develop
```bash
npm install
npm run compile      # solc → scripts/build + web/src/locker-abi.json
npm run deploy       # deploy the locker (reads mnemonic from /tmp/mn.txt or MNEMONIC_FILE)
npm run dev          # run the web app (Vite) at web/
npm run build        # build the static site → web/dist
```

## Stack
- Contracts: Solidity ^0.8.20, solc, deployed with viem.
- Frontend: Vite + TypeScript + viem, EIP-6963 wallet connect. No backend — reads all state straight from the chain.
