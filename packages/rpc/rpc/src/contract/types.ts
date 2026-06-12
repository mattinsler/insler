import type * as z4 from 'zod/v4/core';

import type { ContractDef } from './contract.js';
import type { MethodDef } from './method.js';

// -- Context resolution --

type InferContext<C extends Record<string, z4.$ZodType>> = {
  [K in keyof C]: z4.infer<C[K]>;
};

type ResolveMethodContext<ContractContext, M extends MethodDef> =
  M['context'] extends Record<string, z4.$ZodType>
    ? InferContext<M['context']>
    : ContractContext extends Record<string, z4.$ZodType>
      ? InferContext<ContractContext>
      : {};

type IsEmptyContext<C> = keyof C extends never ? true : false;

// -- Input optionality --

type IsVoidInput<M extends MethodDef> = M['input'] extends z4.$ZodVoid ? true : false;

// -- Handler signatures --

type HandlerSignature<Context, M extends MethodDef> = M['kind'] extends 'serverStream'
  ? IsEmptyContext<ResolveMethodContext<Context, M>> extends true
    ? IsVoidInput<M> extends true
      ? () => AsyncIterable<z4.infer<M['output']>>
      : (input: z4.infer<M['input']>) => AsyncIterable<z4.infer<M['output']>>
    : IsVoidInput<M> extends true
      ? (context: ResolveMethodContext<Context, M>) => AsyncIterable<z4.infer<M['output']>>
      : (
          context: ResolveMethodContext<Context, M>,
          input: z4.infer<M['input']>
        ) => AsyncIterable<z4.infer<M['output']>>
  : M['kind'] extends 'clientStream'
    ? IsEmptyContext<ResolveMethodContext<Context, M>> extends true
      ? (inputStream: AsyncIterable<z4.infer<M['input']>>) => Promise<z4.infer<M['output']>>
      : (
          context: ResolveMethodContext<Context, M>,
          inputStream: AsyncIterable<z4.infer<M['input']>>
        ) => Promise<z4.infer<M['output']>>
    : M['kind'] extends 'duplex'
      ? IsEmptyContext<ResolveMethodContext<Context, M>> extends true
        ? (inputStream: AsyncIterable<z4.infer<M['input']>>) => AsyncIterable<z4.infer<M['output']>>
        : (
            context: ResolveMethodContext<Context, M>,
            inputStream: AsyncIterable<z4.infer<M['input']>>
          ) => AsyncIterable<z4.infer<M['output']>>
      : // unary (default)
        IsEmptyContext<ResolveMethodContext<Context, M>> extends true
        ? IsVoidInput<M> extends true
          ? () => Promise<z4.infer<M['output']>>
          : (input: z4.infer<M['input']>) => Promise<z4.infer<M['output']>>
        : IsVoidInput<M> extends true
          ? (context: ResolveMethodContext<Context, M>) => Promise<z4.infer<M['output']>>
          : (
              context: ResolveMethodContext<Context, M>,
              input: z4.infer<M['input']>
            ) => Promise<z4.infer<M['output']>>;

// -- Client signatures (identical to handler for now) --

type ClientSignature<Context, M extends MethodDef> = HandlerSignature<Context, M>;

// -- Scoped client signatures (context pre-applied) --

type ScopedClientSignature<M extends MethodDef> = M['kind'] extends 'serverStream'
  ? IsVoidInput<M> extends true
    ? () => AsyncIterable<z4.infer<M['output']>>
    : (input: z4.infer<M['input']>) => AsyncIterable<z4.infer<M['output']>>
  : M['kind'] extends 'clientStream'
    ? (inputStream: AsyncIterable<z4.infer<M['input']>>) => Promise<z4.infer<M['output']>>
    : M['kind'] extends 'duplex'
      ? (inputStream: AsyncIterable<z4.infer<M['input']>>) => AsyncIterable<z4.infer<M['output']>>
      : IsVoidInput<M> extends true
        ? () => Promise<z4.infer<M['output']>>
        : (input: z4.infer<M['input']>) => Promise<z4.infer<M['output']>>;

// -- Error types --

type ErrorUnion<Errors extends Record<string, z4.$ZodType>> = {
  [K in keyof Errors & string]: { _tag: K; payload: z4.infer<Errors[K]> };
}[keyof Errors & string];

// -- Result-wrapped client signatures (for errors: 'result' mode) --

type ResultOk<T> = { readonly ok: true; readonly value: T };
type ResultErr<E> = { readonly ok: false; readonly error: E };

type GenericContractError = { readonly _tag: string; readonly payload?: unknown };

type MethodErrorType<M extends MethodDef> =
  M['errors'] extends Record<string, z4.$ZodType> ? ErrorUnion<M['errors']> : GenericContractError;

type WrapPromiseResult<Fn, M extends MethodDef> = Fn extends (
  ...args: infer Args
) => Promise<infer Output>
  ? (...args: Args) => Promise<ResultOk<Output> | ResultErr<MethodErrorType<M>>>
  : Fn;

// -- Public type utilities --

export type InferMethodContext<
  C extends ContractDef,
  MethodName extends keyof C['methods'] & string,
> = ResolveMethodContext<C['context'], C['methods'][MethodName]>;

export type InferHandlers<C extends ContractDef> = {
  [K in keyof C['methods'] & string]: HandlerSignature<C['context'], C['methods'][K]>;
};

export type InferClient<C extends ContractDef> = {
  [K in keyof C['methods'] & string]: ClientSignature<C['context'], C['methods'][K]>;
};

export type InferScopedClient<C extends ContractDef> = {
  [K in keyof C['methods'] & string]: ScopedClientSignature<C['methods'][K]>;
};

export type InferResultClient<C extends ContractDef> = {
  [K in keyof C['methods'] & string]: WrapPromiseResult<
    ClientSignature<C['context'], C['methods'][K]>,
    C['methods'][K]
  >;
};

export type InferResultScopedClient<C extends ContractDef> = {
  [K in keyof C['methods'] & string]: WrapPromiseResult<
    ScopedClientSignature<C['methods'][K]>,
    C['methods'][K]
  >;
};

export type InferErrors<C extends ContractDef, MethodName extends keyof C['methods'] & string> =
  C['methods'][MethodName]['errors'] extends Record<string, z4.$ZodType>
    ? ErrorUnion<C['methods'][MethodName]['errors']>
    : never;
