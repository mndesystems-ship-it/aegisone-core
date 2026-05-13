# Reviewer Target List

## 1. Senior Backend Or Platform Engineers

Who to target:

- staff or principal backend engineers
- platform reliability engineers
- CI/CD or job orchestration owners

Why they fit:

- they understand state drift, execution retries, scheduler behavior, and replay requirements
- they are likely to challenge receipt integrity, contract boundaries, and operational edge cases

What to ask them to test:

- replay exactness
- hidden state leakage across repeated runs
- policy boundary handling under realistic execution load

## 2. Security Or Infrastructure Engineers

Who to target:

- infrastructure security engineers
- cloud security architects
- production risk or controls engineers

Why they fit:

- they will focus on fail-closed behavior, malformed input handling, and tamper resistance
- they are likely to challenge signature validation, duplicate-key rejection, and parser ambiguity

What to ask them to test:

- malformed input refusal
- receipt tamper handling
- policy tamper and boundary contamination cases

## 3. Agent Systems Or Automation Engineers

Who to target:

- agent platform engineers
- workflow automation engineers
- developers shipping tool-execution or orchestration layers

Why they fit:

- they understand execution risk from retries, autoscale, and tool sequencing
- they are likely to pressure-test determinism when an execution layer receives near-identical requests

What to ask them to test:

- tool call reordering
- retry amplification
- parity between independent runtimes enforcing the same contract

## Minimum Reviewer Set

- 2 senior backend or platform engineers
- 1 security or infra engineer
- 1 engineer working on agent systems or automation
- 1 design partner, operator, or potential customer with real execution requests
