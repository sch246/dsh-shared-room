# DSH shared-room

Status: draft independent capability selected for retention while `super-injector` retires. No realization lock is accepted.

## Intent

Provide a reusable shared communication room for multiple agents as an independently installed DeepSeek Harness plugin. Agent Games may compose with it, while the room remains independent of any particular game, role, model, or adjudication rule.

## Acceptance

- The plugin can be installed and removed through ordinary profile composition without `super-injector`.
- Agents can create or join a room, publish messages, and retrieve messages they have not yet consumed.
- Room state survives the running plugin lifecycle expected by the selected deployment.
- Agent Games can use the capability without owning it, and either plugin can remain installed without the other.
- Retiring `super-injector` does not remove or duplicate the capability.

## Constraints and decisions

- Session identity and room data must not be inferred from display order or game-specific roles.
- Exact actions, event fields, persistence format, member-state rules, owner controls, and message presentation are not yet user-locked behavior.
- Builds and structural checks are implementation evidence. User observation on the real profile decides semantic acceptance.

## Non-goals

- Defining games, roles, models, private-message semantics, or adjudication.
- Replacing DeepSeek Harness session persistence generally.
- Preserving the injector-based loading mechanism.
