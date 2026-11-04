# TENET contracts

Smart contracts of [TENET](https://runtenet.app): agentic trading of tokenized stocks on Robinhood Chain (chain id 4663).
Every user has a personal vault. Only the owner can withdraw. An agent, a bot or an algorithm can trade inside the limits the owner
signs, and the vault checks every trade against them on chain.

## Contracts

| Contract | What it does |
|---|---|
| `TenetHub` | Registry: price feeds, fees (each capped at 0.5%), the trade cap, the pause switch. Creates the vaults. |
| `TenetVault` | One per user (a minimal proxy). Owner-only withdrawals, rules, and the agent grant: `agentTrade`, limits, term up to 90 days. |
| `KeeperRegistry` | Open network of executors that stake the project token. |
| `FeeSplitter` | Splits the protocol fee: 30% to the burner, 70% to the authors' pool. |
| `FeeBurner`, `BurnAdapter` | Turns the burner's share into the project token and burns it (through a Uniswap v4 pool, or a bonding curve before a pool exists). |
| `AuthorPayouts` | Pays the authors' pool every hour. |
| `AgentLicenses` | ERC-1155 licenses, paid in the project token. 5% of a sale is burned. |
| `FeePool` | A pool anyone can add to. 30% of a deposit is burned. |

## Mainnet (Robinhood Chain, 4663)

| Contract | Address |
|---|---|
| TenetHub | `0xa69c6d0832473b06fe461ed29acece16342b0c11` |
| Uniswap v4 adapter | `0xbaef9667b94411dfd2cbe2608b039be8bd020881` |
| KeeperRegistry | `0xb66bb3aeda9e025aff1a5b03f9f852f0f2d9d108` |
| FeeSplitter | `0x75b141dabf640935c44702a3a433dabf1f699065` |
| FeeBurner | `0xe73caf67d3e141be91196565042dbdb974d0734f` |
| BurnAdapter | `0xda3493999eb96cb946674e3dbf6166816405b1ac` |
| AuthorPayouts | `0x941b4b2aaec44c0b14c1f9a6c8f8bf7e225c252a` |
| AgentLicenses | `0xa40704589d510773a23c0630f9d674c03e0c6ccf` |
| FeePool | `0x1e01644c40e0c29784f27379c2f8b54b6eef2e09` |

The sources are also verified on Sourcify. The address book with the token list and price feeds is in `deployments/4663.json` and
`config/mainnet.json`.

## Build and test

```
npm install
npx hardhat build
npx hardhat test                 # the local tests
npm run test:fork                # tests against a fork of mainnet (real pools; nothing is spent)
```

The fork tests use the public Robinhood Chain RPC by default. Set `RH_MAINNET_RPC_URL` to use another one.

## Use at your own risk

This is the code that runs on mainnet, published so that you can read it. Read it before you trust it.

## License

MIT. See `LICENSE`.
