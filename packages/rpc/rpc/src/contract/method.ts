import type * as z4 from 'zod/v4/core';

export type MethodKind = 'unary' | 'serverStream' | 'clientStream' | 'duplex';

export interface MethodDef<
  Name extends string = string,
  Kind extends MethodKind = MethodKind,
  Input extends z4.$ZodType = z4.$ZodType,
  Output extends z4.$ZodType = z4.$ZodType,
  Errors extends Record<string, z4.$ZodType> | undefined = Record<string, z4.$ZodType> | undefined,
  Context extends Record<string, z4.$ZodType> | undefined = Record<string, z4.$ZodType> | undefined,
> {
  readonly name: Name;
  readonly kind: Kind;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly errors: Errors;
  readonly context: Context;
}

export interface MethodInput {
  readonly kind?: MethodKind;
  readonly description?: string;
  readonly input?: z4.$ZodType;
  readonly output?: z4.$ZodType;
  readonly errors?: Record<string, z4.$ZodType>;
  readonly context?: Record<string, z4.$ZodType>;
}
