import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import { container } from './container.js';
import * as index from './index.js';
import { BoundToken, inject } from './inject.js';
import { token } from './token.js';

interface Mailer {
  send(to: string, body: string): string;
}
interface Log {
  info(...args: unknown[]): void;
}

const Smtp = token<Mailer>('smtp');
const Logger = token<Log>('logger');
const A = token<number>('a');
const B = token<string>('b');

const mailer: Mailer = { send: (to, body) => `${to}:${body}` };
const log: Log = { info: () => {} };

describe('inject() — public surface', () => {
  test('inject and BoundToken are re-exported from the package index', () => {
    expect(index.inject).toBe(inject);
    expect(index.BoundToken).toBe(BoundToken);
  });

  test('inject() produces a BoundToken', () => {
    const t = inject(A, (a) => a);
    expect(t).toBeInstanceOf(BoundToken);
  });
});

describe('inject() — runtime (dep shapes)', () => {
  test('single token: first parameter is the resolved value', async () => {
    const greet = inject(Logger, (l, name: string) => {
      l.info(name);
      return `hi ${name}`;
    });

    const app = await container()
      .provide(Logger, () => log)
      .provide(greet)
      .start();

    expect(app.get(greet)('matt')).toBe('hi matt');
    await app.stop();
  });

  test('array/tuple of tokens: first parameter is the resolved tuple', async () => {
    const combine = inject([A, B], ([a, b], suffix: string) => `${a}-${b}-${suffix}`);

    const app = await container()
      .provide(A, () => 7)
      .provide(B, () => 'x')
      .provide(combine)
      .start();

    expect(app.get(combine)('!')).toBe('7-x-!');
    await app.stop();
  });

  test('record of tokens: first parameter is the resolved object', async () => {
    const sendEmail = inject(
      { smtp: Smtp, logger: Logger },
      ({ smtp, logger }, to: string, body: string) => {
        logger.info('sending', to);
        return smtp.send(to, body);
      }
    );

    const app = await container()
      .provide(Smtp, () => mailer)
      .provide(Logger, () => log)
      .provide(sendEmail)
      .start();

    expect(app.get(sendEmail)('a@b.com', 'hi')).toBe('a@b.com:hi');
    await app.stop();
  });
});

describe('inject() — semantics', () => {
  test('resolves eagerly — get() returns the callable synchronously', async () => {
    const inc = inject(A, (a, n: number) => a + n);
    const app = await container()
      .provide(A, () => 10)
      .provide(inc)
      .start();

    const fn = app.get(inc); // synchronous, no await
    expect(typeof fn).toBe('function');
    expect(fn(5)).toBe(15);
    await app.stop();
  });

  test('two inject() calls produce tokens with distinct identity', async () => {
    const f1 = inject(A, (a) => a);
    const f2 = inject(A, (a) => a);

    expect(f1).not.toBe(f2);
    expect(f1.name).not.toBe(f2.name);

    const app = await container()
      .provide(A, () => 5)
      .provide(f1)
      .provide(f2)
      .start();

    expect(app.get(f1)()).toBe(5);
    expect(app.get(f2)()).toBe(5);
    await app.stop();
  });

  test('participates in first-registration-wins by token name (re-provide is a no-op)', async () => {
    const t = inject(A, (a) => a + 1);
    const app = await container()
      .provide(A, () => 1)
      .provide(t)
      .provide(t) // idempotent — keyed by token.name
      .start();

    expect(app.get(t)()).toBe(2);
    await app.stop();
  });
});

describe('inject() — types', () => {
  test('single token: first param is the resolved value; remaining args + return follow fn', () => {
    const greet = inject(Logger, (_l, name: string) => `hi ${name}`);
    expectTypeOf(greet).toEqualTypeOf<BoundToken<(name: string) => string>>();

    // first parameter is inferred as the resolved value (Log)
    inject(Logger, (_l: Log, _name: string) => '');
    // @ts-expect-error first parameter must be the resolved value (Log), not number
    inject(Logger, (_l: number, _name: string) => '');
  });

  test('array/tuple: first param is the resolved tuple', () => {
    const combine = inject([A, B], (_d, suffix: string) => suffix);
    expectTypeOf(combine).toEqualTypeOf<BoundToken<(suffix: string) => string>>();

    inject([A, B], (_d: [number, string], _suffix: string) => '');
    // @ts-expect-error first parameter must be the resolved tuple [number, string]
    inject([A, B], (_d: [string, string], _suffix: string) => '');
  });

  test('record: first param is the resolved object', () => {
    const sendEmail = inject(
      { smtp: Smtp, logger: Logger },
      (_d, to: string, body: string) => `${to}${body}`
    );
    expectTypeOf(sendEmail).toEqualTypeOf<BoundToken<(to: string, body: string) => string>>();

    inject({ smtp: Smtp, logger: Logger }, (_d: { smtp: Mailer; logger: Log }, _to: string) => '');
    // @ts-expect-error first parameter must be the resolved record { smtp: Mailer; logger: Log }
    inject({ smtp: Smtp, logger: Logger }, (_d: { smtp: number }, _to: string) => '');
  });

  test('get() returns the bound callable', async () => {
    const inc = inject(A, (a, n: number) => a + n);
    const app = await container()
      .provide(A, () => 1)
      .provide(inc)
      .start();
    expectTypeOf(app.get(inc)).toEqualTypeOf<(n: number) => number>();
    await app.stop();
  });

  test('a non-bound token cannot be provided without a factory', () => {
    const Plain = token<number>('plain');
    // @ts-expect-error a non-bound token requires a deps/factory argument
    container().provide(Plain);
  });
});
