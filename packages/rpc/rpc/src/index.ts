// Root entrypoint: the 0-to-value surface of the @insler/rpc umbrella —
// contract + client + host + memory transport, enough for a working
// in-process service from this package alone. The subpath entrypoints
// (./contract, ./context, ./client, ./host, ./transport-memory) remain the
// canonical import style; layer-specific surfaces that collide across layers
// (e.g. each side's composeMiddleware) live only on their subpath.

export type {
  ContractDef,
  ContractProps,
  MethodDef,
  MethodInput,
  MethodKind,
} from './contract/index.js';
export { Contract } from './contract/index.js';

export type { Propagator } from './context/index.js';
export { createPropagator } from './context/index.js';

export { Client, ContractError } from './client/index.js';
export type {
  ClientMiddleware,
  ClientNext,
  ClientOptions,
  ClientRequest,
  ClientResponse,
  ClientStreamMiddleware,
  ClientTransport,
  ResultClientOptions,
  ThrowClientOptions,
} from './client/index.js';

export { Host } from './host/index.js';
export type {
  HostClientStreamHandler,
  HostDuplexHandler,
  HostHandler,
  HostInstance,
  HostMethodRegistration,
  HostMiddleware,
  HostNext,
  HostOptions,
  HostRegistration,
  HostRequest,
  HostResponse,
  HostStreamHandler,
  HostStreamMiddleware,
  HostTransport,
  HostUnregister,
} from './host/index.js';

export {
  createMemoryTransport,
  MemoryBus,
  MemoryClientTransport,
  MemoryHostTransport,
} from './transport-memory/index.js';
