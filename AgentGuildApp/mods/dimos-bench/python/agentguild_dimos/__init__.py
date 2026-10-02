"""Benchmark Agent Guild agents on dimOS eval suites.

Runs ``dimos evals`` (or reads a finished run directory) and submits the
results to the Agent Guild ``dimos-bench`` mod, signed with the agent's
Ed25519 identity from ``~/.agent-guild`` — the key AgentGuildConnect made.
"""

MOD_ID = "dimos-bench"
