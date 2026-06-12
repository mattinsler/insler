import { z } from 'zod';
import type * as z4 from 'zod/v4/core';

import type { MethodDef, MethodInput, MethodKind } from './method.js';

export interface ContractProps<
  Methods extends Record<string, MethodInput> = Record<string, MethodInput>,
> {
  readonly version: string;
  readonly context?: Record<string, z4.$ZodType>;
  readonly methods: Methods;
  readonly schemas?: Record<string, z4.$ZodType>;
}

type NormalizedMethod<Name extends string, M extends MethodInput> = MethodDef<
  Name,
  M extends { kind: infer K extends MethodKind } ? K : 'unary',
  M extends { input: infer I extends z4.$ZodType } ? I : z4.$ZodVoid,
  M extends { output: infer O extends z4.$ZodType } ? O : z4.$ZodVoid,
  M extends { errors: infer E extends Record<string, z4.$ZodType> } ? E : undefined,
  M extends { context: infer C extends Record<string, z4.$ZodType> } ? C : undefined
>;

type NormalizedMethods<Methods extends Record<string, MethodInput>> = {
  readonly [K in keyof Methods & string]: NormalizedMethod<K, Methods[K]>;
};

type ResolveContext<Props extends ContractProps> = Props extends {
  context: infer C extends Record<string, z4.$ZodType>;
}
  ? C
  : {};

export interface ContractDef<
  Kind extends string = string,
  Props extends ContractProps = ContractProps,
> {
  readonly type: 'contract';
  readonly kind: Kind;
  readonly version: string;
  readonly context: ResolveContext<Props>;
  readonly methods: NormalizedMethods<Props['methods']>;
  readonly methodList: ReadonlyArray<MethodDef>;
  readonly schemas: Record<string, z4.$ZodType> | undefined;
}

function normalizeMethod(name: string, input: MethodInput): MethodDef {
  const method: MethodDef = Object.freeze({
    name,
    kind: input.kind ?? 'unary',
    ...(input.description !== undefined ? { description: input.description } : {}),
    input: input.input ?? z.void(),
    output: input.output ?? z.void(),
    errors: input.errors ?? undefined,
    context: input.context ?? undefined,
  });
  return method;
}

export function createContract<Kind extends string, Props extends ContractProps>(
  kind: Kind,
  props: Props
): ContractDef<Kind, Props> {
  const methods: Record<string, MethodDef> = {};
  const methodList: MethodDef[] = [];

  for (const [name, methodInput] of Object.entries(props.methods)) {
    const method = normalizeMethod(name, methodInput);
    methods[name] = method;
    methodList.push(method);
  }

  const contract = Object.freeze({
    type: 'contract' as const,
    kind,
    version: props.version,
    context: (props.context ?? {}) as ResolveContext<Props>,
    methods: Object.freeze(methods) as NormalizedMethods<Props['methods']>,
    methodList: Object.freeze(methodList),
    schemas: props.schemas,
  });

  return contract;
}
