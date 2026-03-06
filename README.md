# arkade-regtest

A self-contained regtest environment for Ark protocol development. It orchestrates Nigiri (Bitcoin + Liquid regtest), arkd, Fulmine, Boltz, and an LND node into a single reproducible stack using Docker Compose. Intended to be embedded as a git submodule in projects that need a local Ark test network.

## Quick start

```bash
# Start the environment
./start-env.sh

# Stop all services (preserves data)
./stop-env.sh

# Stop and remove all containers, volumes, and build artifacts
./clean-env.sh
```

## Configuration

All defaults live in `.env.defaults`. To override any value, create a `.env` file (git-ignored) and pass it at startup:

```bash
./start-env.sh --env .env
```

Variables in `.env` take precedence over `.env.defaults`. You only need to specify the values you want to change.

## Nigiri resolution

By default, Nigiri is built from source using the `bump-arkd` branch (`NIGIRI_BRANCH` in `.env.defaults`). This ensures all consumers use the exact same version with Ark support.

To use a system-installed nigiri instead, set `NIGIRI_BRANCH=""` in your `.env` override. The script will then use whatever `nigiri` binary is on `$PATH`.

## Service URLs

| Service          | URL / endpoint              | Default port |
| ---------------- | --------------------------- | ------------ |
| Boltz LND P2P    | `localhost:9736`            | 9736         |
| Boltz LND RPC    | `localhost:10010`           | 10010        |
| Fulmine HTTP     | `localhost:7002`            | 7002         |
| Fulmine API      | `localhost:7003`            | 7003         |
| Boltz gRPC       | `localhost:9000`            | 9000         |
| Boltz REST API   | `localhost:9001`            | 9001         |
| Boltz WebSocket  | `localhost:9004`            | 9004         |
| Nginx            | `localhost:9069`            | 9069         |

Nigiri's own services (electrs, esplora, chopsticks, arkd) use their standard ports. See the Nigiri documentation for details.

## Helper scripts

- **`create-invoice.sh`** -- Creates a Lightning invoice on the Boltz LND node. Useful for testing payment flows through Boltz swaps.
- **`pay-invoice.sh`** -- Pays a Lightning invoice from the Boltz LND node. Useful for testing receive flows and Boltz reverse swaps.

## Integration as a submodule

Add this repo as a git submodule in your project:

```bash
git submodule add https://github.com/ArkLabsHQ/arkade-regtest.git arkade-regtest
git submodule update --init --recursive
```

Then call scripts from your project root:

```bash
./arkade-regtest/start-env.sh
./arkade-regtest/start-env.sh --env .env
./arkade-regtest/stop-env.sh
./arkade-regtest/clean-env.sh
```

In CI, make sure your checkout step pulls submodules:

```yaml
- uses: actions/checkout@v4
  with:
    submodules: true
```
