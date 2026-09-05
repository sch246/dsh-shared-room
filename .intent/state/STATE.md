# DSH shared-room

Status: draft product map for the independent shared-room capability retained while `super-injector` retires. Earlier records report an installed alpha.2 candidate; its current deployment and semantic acceptance are not established here.

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

## Installation and maintenance map

The recorded target is Harness alpha.2 at the revision in `STATE.json.resources`; it is compatibility evidence, not a permanent runtime requirement or proof of the present deployment. No realization lock is selected. Start here for current effects and operations; selected LOGs explain consequential choices, and any historical LOCK is optional recovery evidence.

### Sources, ownership and data

`src/index.ts` registers the two room tools and `Config.roomsDir`; `src/store.ts` owns the durable room log, replay and file-locked operations. The default is `~/.dsh/storages/dsh-shared-room/rooms` from the OS home directory, independently of `DSH_HOME`. Set an explicit disposable `roomsDir` for probes. This package carries no Host patch or browser contribution.

The [manifest](../../package.json), [Bundle patch](../../cordis.patch.yml) and [build script](../../scripts/build.sh) own the current executable paths. Read the selected Harness checkout’s `apps/cli/reference/README.md` for profile composition and `docs/development.md` for its build prerequisites. Build against the same checkout that will run the profile, with its dependencies and required peer artifacts ready. Build scripts create local dependency links and `lib/`; these are replaceable outputs, unlike runtime data.

### Build, compose and remove

Set absolute paths and the intended profile; run the build from this plugin checkout. The commands describe installation operations, not actions performed by this document update.

```bash
export DSH_CHECKOUT=/absolute/path/to/deepseek-harness
export DSH_HOME=/absolute/path/to/dsh-home
PROFILE=web
PLUGIN=/absolute/path/to/dsh-shared-room
cd "$PLUGIN"
DSH_CHECKOUT="$DSH_CHECKOUT" bash scripts/build.sh
cd "$DSH_CHECKOUT"
pnpm dsh plugin --profile "$PROFILE" add "$PLUGIN"
pnpm dsh plugin --profile "$PROFILE" why @dsh-external/dsh-shared-room
pnpm dsh --profile "$PROFILE" --dump-config
```

For a requested removal, use the same environment and run from the Harness checkout:

```bash
pnpm dsh plugin --profile "$PROFILE" remove @dsh-external/dsh-shared-room
```

`dsh plugin` maintains the profile dependency, pnpm lockfile, installed resolution and `dsh.profile.bundles` together. After add/update/remove, inspect all four under `$DSH_HOME/profiles/$PROFILE` and the composed config: exactly one `dsh-shared-room` row when installed, none when removed. Later profile/home patches replace a row’s complete config, so preserve existing overrides. A running profile retains its startup Bundle set; activation needs an authorized restart, then a fresh-session check for duplicate tool owners, including residual `super-injector` entries. For first install or changed composition, validate a candidate with the target package set in a private Home before changing a managed profile.

### Upgrade and verification

After a Harness upgrade, inspect tool execution session identity and `dsh-atomic-write` locking before adapting these sources. Preserve existing room data and verify replay before changing formats; corruption must not become an empty room. Agent Games remains an optional consumer. Prefer current Host APIs; add an owned, reversible Host patch only for an otherwise unavailable required effect and retire the patch when upstream provides it.

Run `DSH_CHECKOUT="$DSH_CHECKOUT" npm test` from this repository for build plus `tests/store.test.mjs` and `tests/tools.test.mjs`. Runtime acceptance still needs the multi-session and restart observations above, including non-member writes, non-owner state reads/kicks, owner self-removal refusal, multiline content, and malformed/truncated storage. Use disposable rooms and preserve existing files.

Keep `roomsDir` and its logs. Removing the two tools must not remove Agent Games, Host sessions, or existing rooms; reinstallation can reuse the retained directory.

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
