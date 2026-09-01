# Independent shared-room retention

Date: 2026-09-01

## Authority

During the Harness alpha.2 migration, the user explicitly required retaining `shared-room` as an independent capability that may be used by Agent Games. This desired effect must survive retirement of `super-injector` and must be installed through the ordinary profile composition rather than an injector registry.

## Boundary

The user confirmed a reusable shared-room capability, not every current action, event field, persistence format, member-state rule, or implementation choice. Those details remain realization evidence until separately confirmed.
