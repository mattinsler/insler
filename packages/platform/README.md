# platform — Infrastructure from code

Turn `defineService` declarations into running infrastructure. The `insler`
CLI scans your services into a desired-state model, generates deployment
artifacts through a plugin-based generator — Kubernetes, autoscaling, edge
routing, secret bindings — and reconciles with plan/diff applies:
auto-converge in development, gated and audited in production.
