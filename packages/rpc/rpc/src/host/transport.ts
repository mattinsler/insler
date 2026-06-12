import type { MethodKind } from '../contract/index.js';

export type HostHandler = (request: HostRequest) => Promise<HostResponse>;
export type HostStreamHandler = (request: HostRequest) => AsyncIterable<HostResponse>;
export type HostClientStreamHandler = (
  request: HostRequest,
  inputStream: AsyncIterable<unknown>
) => Promise<HostResponse>;
export type HostDuplexHandler = (
  request: HostRequest,
  inputStream: AsyncIterable<unknown>
) => AsyncIterable<HostResponse>;

export interface HostRequest {
  service: string;
  method: string;
  kind: MethodKind;
  input?: unknown;
  metadata?: Record<string, string>;
}

export interface HostResponse {
  output?: unknown;
  error?: { _tag: string; payload?: unknown; message?: string };
}

export type HostMethodRegistration =
  | { method: string; kind: 'unary'; handler: HostHandler }
  | { method: string; kind: 'serverStream'; handler: HostStreamHandler }
  | { method: string; kind: 'clientStream'; handler: HostClientStreamHandler }
  | { method: string; kind: 'duplex'; handler: HostDuplexHandler };

export interface HostRegistration {
  service: string;
  methods: HostMethodRegistration[];
}

export type HostUnregister = () => Promise<void>;

export interface HostTransport {
  register(registration: HostRegistration): Promise<HostUnregister>;
}
