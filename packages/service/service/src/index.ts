import type { Contract, ContractDef } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import type { HostInstance, HostOptions } from '@insler/rpc/host';
import type { HostMiddleware, HostTransport } from '@insler/rpc/host';
import { loggingMiddleware, validateHandlers } from '@insler/rpc/host/dev';

import { detectEnv } from './env.js';
import type { ServiceEnv } from './env.js';

export { toCallSubjects, toServiceCalls, validateCalls } from './calls.js';
export type { CallInput, ContractCallRef, ServiceCall } from './calls.js';
export type { ServiceEnv } from './env.js';
export { defineService } from './define-service.js';
export type { SerializedServiceDef, ServiceDef, ServiceDefInput } from './define-service.js';
export {
  collectExposeRouteIssues,
  toExposeRoutes,
  validateExpose,
  validateExposeRoutes,
} from './expose.js';
export { deriveIdentity } from './identity.js';
export type { ServiceIdentity } from './identity.js';
export { resolveIsolation } from './isolation.js';
export type { IsolationTier } from './isolation.js';
export type {
  ExposeConfig,
  ExposeRoute,
  ExposeRouteIssue,
  ExposeRouteIssueKind,
  HttpExpose,
  HttpExposeRoute,
  HttpMethod,
  ServiceExposeRoutes,
  StreamMode,
  WebsocketExpose,
  WebsocketExposeRoute,
} from './expose.js';
export { SERVICE_KINDS, serviceKindProfiles, validateServiceKind } from './kind.js';
export type {
  KindDeclaration,
  KindScale,
  OperationalProfile,
  ScalingSignal,
  ServiceKind,
} from './kind.js';
export { toServiceNeeds, validateNeeds } from './needs.js';
export type { ServiceNeed } from './needs.js';
export { resolveScale, validateScale } from './scale.js';
export type { ResolvedScaleConfig, ScaleConfig, ScaleSignal } from './scale.js';

export interface ServiceHostOptions {
  middleware?: HostMiddleware[];
  env?: ServiceEnv;
}

export interface ServiceHostInstance extends HostInstance {
  readonly env: ServiceEnv;
}

function buildHostMiddleware(
  env: ServiceEnv,
  userMiddleware: HostMiddleware[] | undefined
): HostMiddleware[] {
  const stack: HostMiddleware[] = [];

  if (env === 'development') {
    stack.push(loggingMiddleware());
  }

  if (userMiddleware) {
    stack.push(...userMiddleware);
  }

  return stack;
}

export namespace Service {
  export async function create<C extends ContractDef>(
    contract: C,
    handlers: Contract.Handlers<C>,
    transport: HostTransport,
    options?: ServiceHostOptions
  ): Promise<ServiceHostInstance> {
    const env = options?.env ?? detectEnv();

    if (env !== 'production') {
      const missing = validateHandlers(contract, handlers as Record<string, unknown>);
      if (missing.length > 0) {
        throw new Error(`Missing handlers for contract '${contract.kind}': ${missing.join(', ')}`);
      }
    }

    const middleware = buildHostMiddleware(env, options?.middleware);

    const hostOptions: HostOptions | undefined = middleware.length > 0 ? { middleware } : undefined;

    const host = await Host.create(contract, handlers, transport, hostOptions);

    return {
      stop: () => host.stop(),
      env,
    };
  }
}
