# Model Routing

Read this complete file for every DAG containing agents.

## Opt-in Runtime Contract

Routing is runtime-opt-in through root `model_routing.enabled: true`; the authoring skill enables it by default unless the user explicitly requires fixed models. A DAG without the policy retains legacy selector, inheritance, execution, and restart behavior. Routed DAGs are planned recursively before workspace/state initialization or agent execution; there is no routing agent in the graph.

```yaml
swarm:
  model_routing:
    enabled: true
    allowed_aliases:
      [
        pi/smol,
        pi/task,
        pi/default,
        pi/slow,
        pi/plan,
        pi/advisor,
        pi/designer,
        pi/vision,
      ]
    minimum_quality: economy
    max_estimated_cost_usd: 25
    allow_zero_marginal_cost: false
    default_usage:
      input_tokens: 30000
      output_tokens: 6000
      cache_read_tokens: 10000
      cache_write_tokens: 5000
```

Every policy field is required. `max_estimated_cost_usd` is a finite positive subtree cap. Each token bucket is a finite non-negative integer and at least one bucket must be positive.

While routing is enabled, `swarm.model`, agent `model`, and `allowed_aliases` accept only built-in OMP role aliases (`pi/<role>`). Model selectors may add one supported thinking suffix such as `:inherit`, `:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`, or `:auto`; `allowed_aliases` contains base aliases only. Do not use bare roles, configured custom roles, globs, comma fallbacks, `@upstream`, provider/model selectors, or bare model IDs.

An explicit agent model wins. For `planning`, `review`, `design`, and `vision`, an omitted agent model retains the corresponding `pi/plan`, `pi/advisor`, `pi/designer`, or `pi/vision` specialty alias even when that graph declares `swarm.model`. For generic profiles, the graph's `swarm.model` is used when present; otherwise the planner ranks eligible `pi/smol`, `pi/task`, `pi/default`, and `pi/slow` aliases by exposure-adjusted estimated cost after capability and quality filtering.

## Workloads and usage

```yaml
implement:
  type: agent
  role: TypeScript implementer
  workload:
    profile: implementation
    estimated_usage:
      input_tokens: 50000
      output_tokens: 10000
      cache_read_tokens: 20000
      cache_write_tokens: 8000
  task: Implement the requested behavior.
```

Profiles express requirements, not model identities:

| Profile          | Required concrete capability | Intrinsic quality floor |
| ---------------- | ---------------------------- | ----------------------- |
| `general`        | native tools                 | economy                 |
| `implementation` | native tools                 | standard                |
| `planning`       | native tools and reasoning   | premium                 |
| `review`         | native tools and reasoning   | premium                 |
| `design`         | native tools and reasoning   | premium                 |
| `vision`         | native tools and image input | premium                 |

Omitted workload uses `general`. Omitted `estimated_usage` uses the effective policy's `default_usage`; a complete node estimate replaces, rather than merges with, that default. Estimate aggregate tokens for one execution attempt from comparable past tasks or a conservative context/output bound. Include expected cache reads/writes rather than folding them into input.

Catalog prices are USD per million tokens. A positive token bucket requires a finite non-negative catalog rate. An exact zero rate is treated as unknown by default because zero may mean bundled access, missing catalog data, or provider-specific billing. Set `allow_zero_marginal_cost: true` only when accepting exact catalog zero as a documented zero-marginal-cost assumption; missing, negative, or non-finite rates never qualify.

The plan records base cost plus upper-bound exposure from full-DAG iterations, graph repeat rounds, control invalidation attempts, and configured OMP provider retries. It is an estimate, not a forecast: attempts may fail before billable usage, fallback can change rates, user token assumptions can be wrong, and actual provider billing is authoritative.

## Child policy narrowing

The root policy governs the complete recursively hydrated graph. A child may omit `model_routing` to inherit it. A child declaration must keep `enabled: true` and narrow every dimension:

- `allowed_aliases` is a non-empty subset of its parent;
- `minimum_quality` stays equal or rises through `economy < standard < premium`;
- `max_estimated_cost_usd` stays equal or falls and caps that child subtree in addition to the root total;
- `allow_zero_marginal_cost` may change only from `true` to `false`; and
- every `default_usage` bucket stays equal or increases.

A child cannot introduce routing beneath a non-routed root. These rules apply equally to file-backed and inline children.

## Validate, plan, run, and restart

Static validation is intentionally offline:

```bash
omp-swarm validate path/to/swarm.yaml
```

It recursively checks policy shape/narrowing, aliases and thinking suffixes, workload/token shape, graph constraints, and waves. It does not discover authentication, refresh the model catalog, resolve concrete models, create the workspace, or initialize state.

Use the authenticated, read-only planning command before execution:

```bash
omp-swarm plan-models src/swarm/sample-graphs/model-routing.yaml
```

It refreshes OMP's authenticated catalog, resolves role aliases through OMP settings and the model resolver, checks capabilities/prices/budgets for every recursive agent, and prints deterministic rows plus subtree/root totals and assumptions. It initializes no state and runs no node. Normal `omp-swarm <path>` and `/swarm run <path>` perform the same complete planning step before state initialization.

The persisted plan stores the selected alias and the concrete model resolved during planning separately. Agent execution receives the alias, allowing OMP's normal role and provider routing. Runtime progress/result `resolvedModel` records the concrete model OMP actually served, which can differ after fallback; it does not overwrite the planned concrete-model audit record.

A normal restart reuses the persisted routing decision byte-for-byte rather than reranking against new prices or catalog order. The catalog still refreshes so OMP can execute the stable alias. A changed DAG/policy/workload, missing legacy plan, or incompatible alias set fails with instructions to start a fresh normal run.
