import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { Client } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import { createMemoryTransport } from '@insler/rpc/transport-memory';
import { SpanKind, SpanStatusCode, context, trace, type TracerProvider } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';

import { clientTracingMiddleware, hostTracingMiddleware } from './index.js';
import { formatTraceparent, parseTraceparent } from './traceparent.js';

// -- Test contract --

const TestContract = Contract.create('tracing-test', {
  version: '1.0.0',
  methods: {
    echo: {
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    },
    fail: {
      input: z.object({ reason: z.string() }),
      output: z.void(),
      errors: {
        TestError: z.object({ reason: z.string() }),
      },
    },
  },
});

// -- OTel test setup --

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

let contextManager: AsyncHooksContextManager;

beforeEach(async () => {
  contextManager = new AsyncHooksContextManager().enable();
  context.setGlobalContextManager(contextManager);
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider as unknown as TracerProvider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

function getSpans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

// -- Helpers --

async function createPair(
  contract: typeof TestContract,
  handlers: Contract.Handlers<typeof TestContract>
) {
  const { client: clientTransport, host: hostTransport } = createMemoryTransport();
  const host = await Host.create(contract, handlers, hostTransport, {
    middleware: [hostTracingMiddleware()],
  });
  const client = Client.create(contract, clientTransport, {
    middleware: [clientTracingMiddleware()],
  });
  return { client, host };
}

// -- traceparent tests --

describe('traceparent', () => {
  test('formatTraceparent produces valid W3C format', () => {
    const sc = {
      traceId: 'abcdef0123456789abcdef0123456789',
      spanId: '0123456789abcdef',
      traceFlags: 1,
      isRemote: false,
    };
    expect(formatTraceparent(sc)).toBe('00-abcdef0123456789abcdef0123456789-0123456789abcdef-01');
  });

  test('formatTraceparent pads traceFlags', () => {
    const sc = {
      traceId: 'abcdef0123456789abcdef0123456789',
      spanId: '0123456789abcdef',
      traceFlags: 0,
      isRemote: false,
    };
    expect(formatTraceparent(sc)).toBe('00-abcdef0123456789abcdef0123456789-0123456789abcdef-00');
  });

  test('parseTraceparent roundtrips with formatTraceparent', () => {
    const sc = {
      traceId: 'abcdef0123456789abcdef0123456789',
      spanId: '0123456789abcdef',
      traceFlags: 1,
      isRemote: false,
    };
    const parsed = parseTraceparent(formatTraceparent(sc));
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe(sc.traceId);
    expect(parsed!.spanId).toBe(sc.spanId);
    expect(parsed!.traceFlags).toBe(sc.traceFlags);
    expect(parsed!.isRemote).toBe(true);
  });

  test('parseTraceparent returns null for invalid input', () => {
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('not-a-traceparent')).toBeNull();
    expect(parseTraceparent('00-short-short-00')).toBeNull();
    expect(parseTraceparent('01-abcdef0123456789abcdef0123456789-0123456789abcdef-01')).toBeNull();
  });
});

// -- Client middleware tests --

describe('clientTracingMiddleware', () => {
  test('creates a CLIENT span with correct attributes', async () => {
    const { client, host } = await createPair(TestContract, {
      echo: async (input: { value: string }) => ({ value: input.value }),
      fail: async () => {},
    });

    await client.echo({ value: 'hello' });
    await host.stop();

    const spans = getSpans();
    const clientSpan = spans.find((s) => s.kind === SpanKind.CLIENT);
    expect(clientSpan).toBeDefined();
    expect(clientSpan!.name).toBe('tracing-test/echo');
    expect(clientSpan!.attributes['rpc.system']).toBe('insler');
    expect(clientSpan!.attributes['rpc.service']).toBe('tracing-test');
    expect(clientSpan!.attributes['rpc.method']).toBe('echo');
  });

  test('injects traceparent into request metadata', async () => {
    let capturedMetadata: Record<string, string> | undefined;
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    await Host.create(
      TestContract,
      {
        echo: async (input: { value: string }) => ({ value: input.value }),
        fail: async () => {},
      } as any,
      hostTransport,
      {
        middleware: [
          (request, next) => {
            capturedMetadata = request.metadata;
            return next(request);
          },
        ],
      }
    );

    const client = Client.create(TestContract, clientTransport, {
      middleware: [clientTracingMiddleware()],
    });

    await client.echo({ value: 'test' });

    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!['traceparent']).toBeDefined();
    expect(capturedMetadata!['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  test('marks span as error on contract error response', async () => {
    const { client, host } = await createPair(TestContract, {
      echo: async (input: { value: string }) => ({ value: input.value }),
      fail: async () => {
        throw { _tag: 'TestError', payload: { reason: 'boom' } };
      },
    });

    try {
      await client.fail({ reason: 'boom' });
    } catch {
      // expected
    }
    await host.stop();

    const spans = getSpans();
    const clientSpan = spans.find((s) => s.kind === SpanKind.CLIENT);
    expect(clientSpan).toBeDefined();
    expect(clientSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(clientSpan!.attributes['rpc.error_tag']).toBe('TestError');
  });

  test('accepts custom tracer name', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    await Host.create(
      TestContract,
      {
        echo: async (input: { value: string }) => ({ value: input.value }),
        fail: async () => {},
      } as any,
      hostTransport
    );

    const client = Client.create(TestContract, clientTransport, {
      middleware: [clientTracingMiddleware({ tracerName: 'my-client' })],
    });

    await client.echo({ value: 'test' });

    const spans = getSpans();
    const clientSpan = spans.find((s) => s.kind === SpanKind.CLIENT);
    expect(clientSpan).toBeDefined();
    expect(clientSpan!.instrumentationScope.name).toBe('my-client');
  });
});

// -- Host middleware tests --

describe('hostTracingMiddleware', () => {
  test('creates a SERVER span with correct attributes', async () => {
    const { client, host } = await createPair(TestContract, {
      echo: async (input: { value: string }) => ({ value: input.value }),
      fail: async () => {},
    });

    await client.echo({ value: 'hello' });
    await host.stop();

    const spans = getSpans();
    const serverSpan = spans.find((s) => s.kind === SpanKind.SERVER);
    expect(serverSpan).toBeDefined();
    expect(serverSpan!.name).toBe('tracing-test/echo');
    expect(serverSpan!.attributes['rpc.system']).toBe('insler');
    expect(serverSpan!.attributes['rpc.service']).toBe('tracing-test');
    expect(serverSpan!.attributes['rpc.method']).toBe('echo');
  });

  test('links server span to client span via traceparent', async () => {
    const { client, host } = await createPair(TestContract, {
      echo: async (input: { value: string }) => ({ value: input.value }),
      fail: async () => {},
    });

    await client.echo({ value: 'linked' });
    await host.stop();

    const spans = getSpans();
    const clientSpan = spans.find((s) => s.kind === SpanKind.CLIENT);
    const serverSpan = spans.find((s) => s.kind === SpanKind.SERVER);

    expect(clientSpan).toBeDefined();
    expect(serverSpan).toBeDefined();

    // Same trace
    expect(serverSpan!.spanContext().traceId).toBe(clientSpan!.spanContext().traceId);
    // Server's parent is the client span
    expect(serverSpan!.parentSpanContext?.spanId).toBe(clientSpan!.spanContext().spanId);
  });

  test('marks span as error on contract error', async () => {
    const { client, host } = await createPair(TestContract, {
      echo: async (input: { value: string }) => ({ value: input.value }),
      fail: async () => {
        throw { _tag: 'TestError', payload: { reason: 'boom' } };
      },
    });

    try {
      await client.fail({ reason: 'boom' });
    } catch {
      // expected
    }
    await host.stop();

    const spans = getSpans();
    const serverSpan = spans.find(
      (s) => s.kind === SpanKind.SERVER && s.name === 'tracing-test/fail'
    );
    expect(serverSpan).toBeDefined();
    expect(serverSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(serverSpan!.attributes['rpc.error_tag']).toBe('TestError');
  });

  test('accepts custom tracer name', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    await Host.create(
      TestContract,
      {
        echo: async (input: { value: string }) => ({ value: input.value }),
        fail: async () => {},
      } as any,
      hostTransport,
      { middleware: [hostTracingMiddleware({ tracerName: 'my-server' })] }
    );

    const client = Client.create(TestContract, clientTransport);
    await client.echo({ value: 'test' });

    const spans = getSpans();
    const serverSpan = spans.find((s) => s.kind === SpanKind.SERVER);
    expect(serverSpan).toBeDefined();
    expect(serverSpan!.instrumentationScope.name).toBe('my-server');
  });

  test('works without traceparent in metadata', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    await Host.create(
      TestContract,
      {
        echo: async (input: { value: string }) => ({ value: input.value }),
        fail: async () => {},
      } as any,
      hostTransport,
      { middleware: [hostTracingMiddleware()] }
    );

    // Client without tracing middleware — no traceparent injected
    const client = Client.create(TestContract, clientTransport);
    await client.echo({ value: 'no-trace' });

    const spans = getSpans();
    const serverSpan = spans.find((s) => s.kind === SpanKind.SERVER);
    expect(serverSpan).toBeDefined();
    expect(serverSpan!.name).toBe('tracing-test/echo');
    // No parent since no traceparent was sent
    expect(serverSpan!.parentSpanContext?.spanId).toBeUndefined();
  });
});

// -- Roundtrip tests --

describe('roundtrip tracing', () => {
  test('successful call produces linked client + server spans', async () => {
    const { client, host } = await createPair(TestContract, {
      echo: async (input: { value: string }) => ({ value: input.value }),
      fail: async () => {},
    });

    const result = await client.echo({ value: 'roundtrip' });
    expect(result).toEqual({ value: 'roundtrip' });
    await host.stop();

    const spans = getSpans();
    expect(spans).toHaveLength(2);

    const clientSpan = spans.find((s) => s.kind === SpanKind.CLIENT)!;
    const serverSpan = spans.find((s) => s.kind === SpanKind.SERVER)!;

    // Both completed successfully
    expect(clientSpan.status.code).toBe(SpanStatusCode.UNSET);
    expect(serverSpan.status.code).toBe(SpanStatusCode.UNSET);

    // Same trace, server is child of client
    expect(serverSpan.spanContext().traceId).toBe(clientSpan.spanContext().traceId);
    expect(serverSpan.parentSpanContext?.spanId).toBe(clientSpan.spanContext().spanId);
  });

  test('error call produces linked error spans on both sides', async () => {
    const { client, host } = await createPair(TestContract, {
      echo: async (input: { value: string }) => ({ value: input.value }),
      fail: async () => {
        throw { _tag: 'TestError', payload: { reason: 'roundtrip-error' } };
      },
    });

    try {
      await client.fail({ reason: 'roundtrip-error' });
    } catch {
      // expected
    }
    await host.stop();

    const spans = getSpans();
    const clientSpan = spans.find((s) => s.kind === SpanKind.CLIENT)!;
    const serverSpan = spans.find((s) => s.kind === SpanKind.SERVER)!;

    expect(clientSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(serverSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(clientSpan.attributes['rpc.error_tag']).toBe('TestError');
    expect(serverSpan.attributes['rpc.error_tag']).toBe('TestError');
  });

  test('preserves existing metadata when injecting traceparent', async () => {
    let capturedMetadata: Record<string, string> | undefined;
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    await Host.create(
      TestContract,
      {
        echo: async (input: { value: string }) => ({ value: input.value }),
        fail: async () => {},
      } as any,
      hostTransport,
      {
        middleware: [
          (request, next) => {
            capturedMetadata = request.metadata;
            return next(request);
          },
        ],
      }
    );

    const client = Client.create(TestContract, clientTransport, {
      middleware: [
        (request, next) =>
          next({ ...request, metadata: { ...request.metadata, 'x-custom': 'value' } }),
        clientTracingMiddleware(),
      ],
    });

    await client.echo({ value: 'test' });

    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!['x-custom']).toBe('value');
    expect(capturedMetadata!['traceparent']).toBeDefined();
  });

  test('host span context is active during handler execution', async () => {
    let activeSpanDuringHandler: any = null;
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    await Host.create(
      TestContract,
      {
        echo: async (input: { value: string }) => {
          const span = trace.getActiveSpan();
          activeSpanDuringHandler = span;
          return { value: input.value };
        },
        fail: async () => {},
      } as any,
      hostTransport,
      { middleware: [hostTracingMiddleware()] }
    );

    const client = Client.create(TestContract, clientTransport, {
      middleware: [clientTracingMiddleware()],
    });

    await client.echo({ value: 'context-test' });

    expect(activeSpanDuringHandler).not.toBeNull();
    const spans = getSpans();
    const serverSpan = spans.find((s) => s.kind === SpanKind.SERVER)!;
    expect(activeSpanDuringHandler.spanContext().spanId).toBe(serverSpan.spanContext().spanId);
  });
});
