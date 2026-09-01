# DSH shared-room

Status: draft product map for the independent shared-room capability retained while `super-injector` retires. The alpha.2 candidate is installed but not yet accepted through a realization lock.

## Product direction

Give multiple Agents a durable shared room where each member can publish events, consume only its own unread increment, and maintain member state without the coordinator manually copying conversation deltas. The room is reusable infrastructure: Agent Games may compose with it, but it contains no game-specific roles or rules.

## Required capabilities and verification

- The plugin can be installed and removed through ordinary profile composition without `super-injector`.
- `shared_room create` creates a unique room, makes the calling session its sole owner and first member, and returns the room id plus enough instruction for another Agent to join and participate.
- `join` registers another session and is idempotent for an existing member. Posting, reading or changing member state requires current membership.
- `say` appends a public message without advancing the sender's unread cursor. Multiline message content remains content rather than being interpreted as room control data.
- `check` returns only public events the calling member has not yet acknowledged and advances only that member's cursor. Other members retain their own unread increments.
- The room has one stable owner. The owner can remove an obsolete non-owner member; a non-owner cannot remove members, and the owner cannot be removed through that action.
- `shared_room_state` lets a member set its own JSON-valued state. The owner can read one current member or list all current members; ordinary members cannot inspect another member's private state.
- Member state remains outside the public unread event stream. A display-name convention may affect event presentation without replacing stable session identity or authorization.
- Room events, membership, member state and unread positions survive plugin reload and Web restart through durable storage. Removing a member clears that member's state and unread responsibility; rejoining starts a new membership state.
- Agent Games can use the capability without owning it, and either plugin can remain installed without the other.
- Retiring `super-injector` does not remove or duplicate the capability.

Relevant verification uses several real sessions to exercise create, repeated join, say/check ordering, independent cursors, member state authorization, owner removal and restart recovery. Source inspection or a single-session tool call is insufficient.

## Current alpha.2 realization map

- Identify and preserve the deployment's existing room-storage directory before changing the package or profile. Treat its contents as user runtime data, not rebuild output.
- Build the package against the selected Harness source checkout so its declarations and runtime imports resolve the same alpha.2 tool APIs as the profile.
- Install the package checkout through `dsh plugin --profile <name> add <checkout>`. Its package manifest must contribute its own Bundle patch, and the profile must contain both the dependency and the Bundle membership.
- Restart the profile after Bundle membership changes. Confirm the composed config contains exactly one `dsh-shared-room` row and no injector-owned duplicate.
- Perform the multi-session and restart observations above against a disposable room before accepting a realization; preserve pre-existing rooms throughout verification.

## Conditional avoidance

- Session identity and room data must not be inferred from display order or game-specific roles.
- A member's `say` must not silently acknowledge unread input; otherwise turn-order strategies become impossible.
- Public message reads must not expose another member's private state, and state reads must not move public unread cursors.
- Reload compaction may discard acknowledged in-memory delivery entries but must not lose the durable information needed to reconstruct current room behavior.
- Storage corruption or an unsupported format must fail visibly rather than silently resetting a room.

## Target-dependent commitments

- When maintenance targets a deployment with existing rooms, their current behavior and data remain in scope across format or implementation changes. A fresh deployment with no prior rooms has no migration obligation.
- When Agent Games is installed and a selected game declares shared-room composition, the generic room remains available to that workflow. Without Agent Games, shared-room does not recreate game concepts.
- When the target exposes a distinct display-name concept, room presentation may project it while stable session identity continues to own membership and authorization. A target without display names does not need a synthetic naming subsystem.

Private messaging, ownership transfer, game-specific state and built-in adjudication require separate intent; generic member state does not imply them. Exact event fields, durable bytes and visual formatting are not yet locked behavior.

## Non-goals

- Defining games, roles, models, private-message semantics, or adjudication.
- Replacing DeepSeek Harness session persistence generally.
- Preserving the injector-based loading mechanism.
