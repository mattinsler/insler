import type { ContractDef, ContractProps } from './contract.js';
import { createContract } from './contract.js';
import type {
  InferClient,
  InferErrors,
  InferHandlers,
  InferMethodContext,
  InferResultClient,
  InferResultScopedClient,
  InferScopedClient,
} from './types.js';

export type { MethodDef, MethodInput, MethodKind } from './method.js';
export type { ContractDef, ContractProps } from './contract.js';

export namespace Contract {
  export const create: <Kind extends string, Props extends ContractProps>(
    kind: Kind,
    props: Props
  ) => ContractDef<Kind, Props> = createContract;

  export type MethodContext<
    C extends ContractDef,
    M extends keyof C['methods'] & string,
  > = InferMethodContext<C, M>;

  export type Handlers<C extends ContractDef> = InferHandlers<C>;
  export type Client<C extends ContractDef> = InferClient<C>;
  export type ScopedClient<C extends ContractDef> = InferScopedClient<C>;
  export type ResultClient<C extends ContractDef> = InferResultClient<C>;
  export type ResultScopedClient<C extends ContractDef> = InferResultScopedClient<C>;

  export type Errors<C extends ContractDef, M extends keyof C['methods'] & string> = InferErrors<
    C,
    M
  >;
}
