.PHONY: eval-system-prompt

RUNS ?= 3
SCENARIO ?=
MODEL ?=
THINKING ?= low

eval-system-prompt:
	OMP_EVAL_RUNS="$(RUNS)" OMP_EVAL_SCENARIO="$(SCENARIO)" OMP_EVAL_MODEL="$(MODEL)" OMP_EVAL_THINKING="$(THINKING)" bun src/system-prompt/eval/index.ts

install:
	pnpm install && pnpm prepare
