## Tempo channel contracts

Foundry project for `ChannelManager`, the Tempo state-channel contract. See `DESIGN.md` for the design reasoning and open questions.

### Deployments

| Network | Address | Status |
|---|---|---|
| Moderato testnet (chain id `42431`) | [`0xCa234b7cF576A4dd65bF28C6405d91eEA1f57789`](https://explore.tempo.xyz/address/0xCa234b7cF576A4dd65bF28C6405d91eEA1f57789) | Current capability-enabled deployment, block `38381392` |
| Moderato testnet (chain id `42431`) | [`0xE044C8DeCdc74503B2E0B12a63C7F1Da85717567`](https://explore.tempo.xyz/address/0xE044C8DeCdc74503B2E0B12a63C7F1Da85717567) | Previous deployment — predates channel-scoped capabilities |

Current deployment transaction:
[`0x9263e1e2…f71b7cd5`](https://explore.tempo.xyz/tx/0x9263e1e25c42e1d97211b7fc0acae34edfc9f46761d0353a8ac82676f71b7cd5).
The receipt succeeded with Tempo transaction type `0x76`, paying fees in
PathUSD. The deployed bytecode and `PROTOCOL_VERSION() == 1` were verified over
the Moderato RPC.

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
$ forge create src/ChannelManager.sol:ChannelManager --rpc-url moderato --interactive --tempo.fee-token PathUSD --broadcast
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
