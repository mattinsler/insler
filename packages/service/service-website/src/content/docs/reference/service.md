---
title: '@insler/service'
description: The full public surface of the single-entrypoint service umbrella — the env-aware runtime wrapper and the defineService deployment-intent declaration model.
sidebar:
  order: 1
---

service is a **single-entrypoint core**: the root `@insler/service` import is
the whole public surface, covering two distinct roles. Its runtime
dependencies are exactly `@insler/rpc` and `std-env` — it is the top of the
RPC stack; nothing internal depends on it.

```sh
bun add @insler/service
```

## The runtime wrapper — `Service.create`

```ts
Service.create(contract, handlers, transport, options?) => Promise<ServiceHostInstance>
```

An env-aware wrapper over the rpc host — policy, not mechanics:

- **Environment detection.** The returned instance carries a readonly `env`
  (`'development' | 'test' | 'production'`), detected via `std-env`:
  `NODE_ENV=test` or a test runner → `test`; `production` → `production`;
  `development` → `development`; fallback → `production`. Override with
  `options.env`.
- **Handler completeness.** Outside production, a handler missing for any
  contract method throws at startup.
- **Dev-mode logging.** In `development`, logging middleware is applied
  automatically; `options.middleware` appends your own.
- The transport is an injected `HostTransport` — in-memory or the
  [rpc subsystem](https://rpc.insler.dev)'s NATS transport, the handlers
  never change. `stop()` tears the host down.

Handlers are fully typed via the rpc core's `Contract.Handlers<C>`; callers
derive clients with `Client.create` from `@insler/rpc/client`.

## The declaration model — `defineService`

```ts
defineService({ name, kind, contract, needs?, calls?, scale?, isolation?, expose?, taskQueue? }) => ServiceDef
```

The single entry point for a service's deployment intent. It validates every
axis (throwing with the full issue list at declaration time), resolves
defaults, and returns a **deeply-frozen**, statically-analyzable
`ServiceDef` tagged `type: 'service'` — the declaration the platform's
scanner discovers in `*.service.ts` / `*.def.ts` files.

### Kind — the lifecycle axis

`kind: 'ephemeral' | 'persistent' | 'workflow'`. The decision rule: does the
service hold state or work *between* requests? No → `ephemeral` (scale to
zero allowed; externalize cross-request state to stay ephemeral). Yes →
`persistent` (replica floor ≥ 1). `workflow` is a durable orchestration
worker: it requires a `taskQueue` (compile-time enforced — the other kinds
reject one) and inherits `persistent`'s operational profile, scaling on
task-queue backlog. The per-kind defaults are exported as
`serviceKindProfiles`, with `SERVICE_KINDS` and `validateServiceKind`
alongside.

### Identity — derived, not declared

`deriveIdentity(def, env)` returns the deterministic, hierarchical
`ServiceIdentity`: `qualifiedName` is `environment.namespace.name` (e.g.
`prod.commerce.orders`, namespace defaulting to `default`). It anchors NATS
credential scoping, secret paths, ServiceAccounts, and telemetry
attribution.

### Needs, calls, scale, isolation, expose

- **`needs`** — logical resource names (`'orders-db'`, `'valkey'`), never
  connection strings; projected to the always-present `needRefs`.
- **`calls`** — cross-service dependencies as subject strings or typed
  `{ contract, method }` references (a method typo is a compile error);
  projected to resolved subject strings plus `callRefs`.
- **`scale`** — bounds and signal; `resolveScale` applies the kind's default
  signal and replica floor onto the always-present `effectiveScale` (a
  `persistent` floor of 0 is a declaration-time error).
- **`isolation`** — `'default' | 'gvisor' | 'microvm'`, resolved onto
  `effectiveIsolation` via `resolveIsolation`.
- **`expose`** — optional HTTP/WebSocket edge routes, flattened to
  `exposeRoutes` with intra-service collision checks. Orthogonal to `kind`.

### Serialization

The frozen def keeps the **live contract** (zod schemas intact) for the
runtime path; `toJSON()` yields the `SerializedServiceDef` — the contract
reduced to `{ kind, version }` — so the generator consumes pure, JSON-safe
intent. Declarations must stay free of runtime values (env vars, computed
config).

## Boundaries

The contract, calling mechanics, low-level validation, and transports belong
to the [rpc subsystem](https://rpc.insler.dev); the layers that compile a
`ServiceDef` into running fleets (scanning, codegen, reconciliation) are the
platform subsystem. This package is the seam between them: env-aware policy
on the way in, statically-analyzable intent on the way out.
