# Measurement entity lineage v1

## Pre-registered hypothesis

The terminal seed-185 diagnostic reached month 2,216 and then failed before
publishing month 2,217 because a newly created instrument stack carried 25
`sourceEventIds`, while measurement and bounded-retention contracts require at
most 24. The prior authoritative root is preserved at
`three-body/data/nextgen-intelligence-v1-ppdescriptor-s185`; it is diagnostic
only and must not be resumed or mixed into a new run.

The earliest break is an engine invariant, not a missing civilization motive:
the merge paths in `domain/actions/inventory.ts` bound and deduplicate entity
source IDs, but the new inventory, container-inventory, and ground-drop paths
copy an already-full lineage without applying the same bound. A death or
transfer witness can therefore create 25+ sources even though every later
consumer is fail-closed at 24.

Hypothesis: applying the existing deterministic last-24, unique-source policy
to every newly created inventory stack, container stack, and ground drop will
keep physical entity provenance within the established contract and allow
terminal evolution to continue past ordinary death and transfer succession.
This changes neither material quantities nor action legality and introduces no
era, civilization-index, person, seed, or run-specific rule.

## Minimum acceptance

- New and merged entity paths use one identical deterministic source selector:
  stable input order, duplicate removal, then the last 24 real event IDs.
- A 24-source entity followed by death/drop and pickup remains at 24 sources;
  the real death and transfer witnesses are retained and no source is invented.
- The resulting instrument can still be accepted only when its retained
  sources include a real manufacture fact for the same material. Truncation
  must not turn an unsupported artifact into a supported one.
- Bounded retention can collect the resulting current instrument demand
  without an over-limit failure; full and bounded execution use the exact same
  source IDs.
- A focused fixture, backend build, and scoped diff check pass. No short or
  long evolution run is started for this invariant fix. Its terminal evidence
  belongs to the next three-seed genesis generation after integration.

## Rejection conditions

- Raising the limit, accepting unresolved sources, keeping arbitrary bodies,
  inventing a summary event, or using observer/era state to bypass validation.
- Mutating or resuming the preserved month-2,216 diagnostic database.
- Applying different source selection in storage and gameplay, or silently
  changing material quantities, ownership, or action outcomes.
