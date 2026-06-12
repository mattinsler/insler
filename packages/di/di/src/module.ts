import type { ContainerBuilder } from './container.js';

/**
 * A reusable unit of container wiring — the lingua franca of `.use(...)`.
 *
 * A `Pack` takes a builder and returns it (after registering bindings, composing
 * other packs, etc.). It is typed against the base `ContainerBuilder`; the
 * `Object.assign`-augmented helper-pack pattern (where `.use` widens the builder
 * with extra methods) is deliberately not captured here and stays hand-written.
 */
export type Pack = (builder: ContainerBuilder) => ContainerBuilder;

/**
 * A configurable definition unit produced by {@link module}. Always called to
 * produce a {@link Pack} — `.use(database({ url }))`, `.use(cache())` — never
 * passed bare to `.use`.
 */
export type Module<Config = void> = (
  ...args: [Config] extends [void] ? [] : [config: Config]
) => Pack;

/**
 * Roll a set of definitions plus an optional configuration surface into a single
 * named export a consumer applies with `.use(...)`.
 *
 * Pure currying over `provide`/`use`/tokens: it registers nothing itself and adds
 * no resolution semantics. The dev/prod swap and override-by-precedence behaviors
 * ride on first-registration-wins exactly as the hand-written `configure` pattern
 * does — select which module's pack runs first.
 *
 * "Choosing plugins" falls out for free: the config can carry `Pack[]`.
 */
export function module<Config = void>(
  build: (builder: ContainerBuilder, config: Config) => ContainerBuilder
): Module<Config> {
  return ((config?: Config) =>
    (builder: ContainerBuilder): ContainerBuilder =>
      build(builder, config as Config)) as Module<Config>;
}
