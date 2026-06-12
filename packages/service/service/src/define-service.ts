import type { ContractDef } from '@insler/rpc/contract';

import {
  type CallInput,
  type ServiceCall,
  toCallSubjects,
  toServiceCalls,
  validateCalls,
} from './calls.js';
import { type ExposeConfig, type ExposeRoute, toExposeRoutes, validateExpose } from './expose.js';
import { type IsolationTier, resolveIsolation } from './isolation.js';
import { type KindDeclaration, type ServiceKind, validateServiceKind } from './kind.js';
import { type ServiceNeed, toServiceNeeds, validateNeeds } from './needs.js';
import {
  type ResolvedScaleConfig,
  type ScaleConfig,
  resolveScale,
  validateScale,
} from './scale.js';

/**
 * The typed declaration a service author writes next to their service code.
 *
 * `defineService` is the single entry point for all operational intent —
 * identity, lifecycle kind, the RPC contract, logical needs, cross-service
 * calls, scaling, isolation, and external exposure. It produces a frozen
 * {@link ServiceDef} that the generator (static analysis), the reconciler, and
 * the runtime (`Service.create`) all consume.
 *
 * The declaration must be **statically analyzable**: it carries only literal,
 * JSON-serializable intent plus a reference to a framework `Contract`. It must
 * not depend on runtime values (env vars, computed config). The generator can
 * therefore extract it without executing the service.
 */

/** The operational intent shared by every service kind. */
interface CommonServiceFields<C extends ContractDef> {
  /** Stable service identity. */
  readonly name: string;
  /** The framework `Contract` defining this service's RPC surface. */
  readonly contract: C;
  /**
   * Logical data-store / resource needs, resolved to physical resources by
   * convention downstream. Authors declare _what_ they need (e.g. `'orders-db'`,
   * `'valkey'`), never _how_ it connects. Duplicate needs are rejected. The
   * frozen {@link ServiceDef} exposes the typed-reference view as `needRefs`.
   */
  readonly needs?: readonly string[];
  /**
   * Cross-service contracts this service calls. Each entry is a stable NATS
   * subject reference (`'orders.create'`) or a typed contract reference
   * (`{ contract: OrdersContract, method: 'create' }`) for compile-time
   * checking — never deployment configuration. Duplicate calls are rejected.
   * The frozen {@link ServiceDef} exposes the typed-reference view as
   * `callRefs`; `calls` itself is reduced to the resolved subject strings.
   */
  readonly calls?: readonly CallInput[];
  /** Scaling configuration. */
  readonly scale?: ScaleConfig;
  /**
   * Sandbox / RuntimeClass tier. Defaults to `'default'` (a standard container)
   * when omitted; the frozen {@link ServiceDef} exposes the resolved value as
   * `effectiveIsolation`.
   */
  readonly isolation?: IsolationTier;
  /**
   * Optional external exposure via the edge bridge (#0007). Orthogonal to
   * `kind` — declaring exposure does not change the service's lifecycle kind or
   * its NATS-only internal protocol; the edge bridge (#0020) translates. The
   * frozen {@link ServiceDef} exposes the flattened routing-table view as
   * `exposeRoutes`. Within a service, no two routes may collide on the same
   * `(method, path)` (HTTP) or `path` (WebSocket); cross-service uniqueness is
   * checked by the edge-gateway routing generator (#0014).
   */
  readonly expose?: ExposeConfig;
}

/**
 * The options accepted by {@link defineService}, discriminated on `kind`.
 *
 * `name`, `kind`, and `contract` are required; everything else is optional.
 * `workflow` additionally requires a `taskQueue`; the other kinds must not
 * carry one (compile-time enforced, mirroring the #0002 `KindDeclaration`).
 */
export type ServiceDefInput<C extends ContractDef = ContractDef> =
  | (CommonServiceFields<C> & { readonly kind: 'ephemeral'; readonly taskQueue?: never })
  | (CommonServiceFields<C> & { readonly kind: 'persistent'; readonly taskQueue?: never })
  | (CommonServiceFields<C> & { readonly kind: 'workflow'; readonly taskQueue: string });

/**
 * Per-element validation of a `calls` tuple: a string entry passes as-is; a
 * typed contract reference is checked so its `method` is a real method on the
 * referenced contract (a typo / removed method is a compile error). Used as an
 * intersection constraint in {@link defineService} so the check fires on the
 * inline literal the author writes.
 */
type ValidateCalls<Calls extends readonly CallInput[]> = {
  readonly [I in keyof Calls]: Calls[I] extends string
    ? Calls[I]
    : Calls[I] extends { readonly contract: infer C extends ContractDef }
      ? { readonly contract: C; readonly method: keyof C['methods'] & string }
      : never;
};

/**
 * The frozen declaration produced by {@link defineService}.
 *
 * Retains the live `contract` (zod schemas intact) for the runtime path while
 * serializing to a static, JSON-safe view (the contract reduced to its
 * `{ kind, version }` identity) for the generator via {@link toJSON}.
 */
export type ServiceDef<C extends ContractDef = ContractDef> = {
  readonly type: 'service';
  readonly name: string;
  readonly kind: ServiceKind;
  readonly contract: C;
  readonly taskQueue?: string;
  readonly needs?: readonly string[];
  /**
   * The typed-reference projection of `needs` (#0005). Always present (empty
   * when no needs are declared); each entry is a logical {@link ServiceNeed}
   * that downstream generators (#0015 secret bindings, #0017 data-store claims)
   * and the service graph (#0010) consume.
   */
  readonly needRefs: readonly ServiceNeed[];
  /**
   * The resolved subject strings for `calls` (#0006). A typed contract
   * reference is reduced to its `{kind}.{method}` subject here, keeping the
   * view JSON-serializable (no live zod schemas). Absent when no calls declared.
   */
  readonly calls?: readonly string[];
  /**
   * The typed-reference projection of `calls` (#0006). Always present (empty
   * when no calls are declared); each entry is a {@link ServiceCall} carrying
   * only the contract subject. The service graph (#0010) cross-references these
   * against known service subjects to build the dependency graph.
   */
  readonly callRefs: readonly ServiceCall[];
  readonly scale?: ScaleConfig;
  /**
   * The **effective** scale (#0008): the declared `scale` with the kind's
   * default signal and replica floor applied. Always present — when `scale` is
   * omitted it is the kind's default profile (`ephemeral` → `queue-depth`/min 0,
   * `persistent` → `cpu`/min 1, `workflow` → `task-queue-backlog`/min 1). The
   * autoscaler generator (#0013) consumes this to emit a KEDA ScaledObject / HPA.
   */
  readonly effectiveScale: ResolvedScaleConfig;
  readonly isolation?: IsolationTier;
  /**
   * The **effective** isolation tier (#0009): the declared `isolation`, or
   * `'default'` (a standard container) when omitted. Always present. The
   * Kubernetes manifest generator (#0012) consumes this to select a RuntimeClass
   * and validate host capabilities (a `microvm` tier requires a KVM-capable node).
   */
  readonly effectiveIsolation: IsolationTier;
  readonly expose?: ExposeConfig;
  /**
   * The flattened, transport-agnostic projection of `expose` (#0007). Always
   * present (empty when nothing is exposed); each entry is one {@link ExposeRoute}
   * (an HTTP route or the WebSocket endpoint). The edge-gateway routing
   * generator (#0014) collects these across all services to synthesize the
   * single edge routing table and to enforce fleet-wide path uniqueness.
   */
  readonly exposeRoutes: readonly ExposeRoute[];
  /** The static, JSON-serializable view consumed by the generator. */
  toJSON(): SerializedServiceDef;
};

/** The static, JSON-serializable projection of a {@link ServiceDef}. */
export interface SerializedServiceDef {
  readonly type: 'service';
  readonly name: string;
  readonly kind: ServiceKind;
  readonly contract: { readonly kind: string; readonly version: string };
  readonly taskQueue?: string;
  readonly needs?: readonly string[];
  readonly calls?: readonly string[];
  readonly scale?: ScaleConfig;
  readonly isolation?: IsolationTier;
  readonly expose?: ExposeConfig;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      freezeDeep((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Declare a service: wrap a framework `Contract` with operational intent.
 *
 * Returns a deeply-frozen {@link ServiceDef}. The result feeds `Service.create`
 * at runtime (it keeps the live contract) and is extractable at build time by
 * the generator (it serializes to JSON via {@link SerializedServiceDef}).
 */
export function defineService<C extends ContractDef, const Calls extends readonly CallInput[]>(
  options: ServiceDefInput<C> & { readonly calls?: Calls & ValidateCalls<Calls> }
): ServiceDef<C> {
  const { name, kind, contract, needs, calls, scale, isolation, expose } = options;
  const taskQueue = kind === 'workflow' ? options.taskQueue : undefined;

  const needIssues = validateNeeds(needs);
  if (needIssues.length > 0) {
    throw new Error(`Invalid 'needs' for service '${name}': ${needIssues.join('; ')}`);
  }

  const callIssues = validateCalls(calls);
  if (callIssues.length > 0) {
    throw new Error(`Invalid 'calls' for service '${name}': ${callIssues.join('; ')}`);
  }

  const exposeIssues = validateExpose(expose);
  if (exposeIssues.length > 0) {
    throw new Error(`Invalid 'expose' for service '${name}': ${exposeIssues.join('; ')}`);
  }

  const scaleIssues = validateScale(kind, scale);
  if (scaleIssues.length > 0) {
    throw new Error(`Invalid 'scale' for service '${name}': ${scaleIssues.join('; ')}`);
  }

  // The #0002 kind/lifecycle rules. The replica-floor half overlaps validateScale
  // (which already threw above), so what this adds at declaration time is the
  // taskQueue rule — e.g. a workflow declaring an empty queue name.
  const kindIssues = validateServiceKind({ kind, taskQueue, scale } as KindDeclaration);
  if (kindIssues.length > 0) {
    throw new Error(`Invalid declaration for service '${name}': ${kindIssues.join('; ')}`);
  }

  const callSubjects = calls !== undefined ? toCallSubjects(calls) : undefined;
  const effectiveScale = resolveScale(kind, scale);
  const effectiveIsolation = resolveIsolation(isolation);

  const def = {
    type: 'service' as const,
    name,
    kind,
    contract,
    needRefs: toServiceNeeds(needs),
    callRefs: toServiceCalls(calls),
    exposeRoutes: toExposeRoutes(expose),
    effectiveScale,
    effectiveIsolation,
    ...(taskQueue !== undefined ? { taskQueue } : {}),
    ...(needs !== undefined ? { needs: freezeDeep([...needs]) } : {}),
    ...(callSubjects !== undefined ? { calls: callSubjects } : {}),
    ...(scale !== undefined ? { scale: freezeDeep({ ...scale }) } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(expose !== undefined ? { expose: freezeDeep(structuredClone(expose)) } : {}),
    toJSON(): SerializedServiceDef {
      return {
        type: 'service',
        name,
        kind,
        contract: { kind: contract.kind, version: contract.version },
        ...(taskQueue !== undefined ? { taskQueue } : {}),
        ...(needs !== undefined ? { needs } : {}),
        ...(callSubjects !== undefined ? { calls: callSubjects } : {}),
        ...(scale !== undefined ? { scale } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        ...(expose !== undefined ? { expose } : {}),
      };
    },
  };

  return Object.freeze(def) as ServiceDef<C>;
}
