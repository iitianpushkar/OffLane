## Tempo channel contracts

Foundry project for `ChannelManager`, the Tempo state-channel contract. See `DESIGN.md` for the design reasoning and open questions.

### Deployments

| Network | Address | Status |
|---|---|---|
| Moderato testnet (chain id `42431`) | [`0xE044C8DeCdc74503B2E0B12a63C7F1Da85717567`](https://explore.testnet.tempo.xyz/address/0xE044C8DeCdc74503B2E0B12a63C7F1Da85717567) | Previous deployment — predates channel-scoped capabilities |

Verified end-to-end via `script/SmokeTest.s.sol` (open → join → cooperativeClose against real testnet pathUSD). See `DESIGN.md`'s "Verified" section for details.

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge create src/ChannelManager.sol:ChannelManager --rpc-url moderato --interactive --broadcast --verify
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
