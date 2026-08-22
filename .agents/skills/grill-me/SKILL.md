---
name: grill-me
description: Run a read-only decision interview that pressure-tests a plan, design, or idea one consequential question at a time. Use only when the user explicitly invokes $grill-me before implementation.
---

# Grill Me

Turn a plan, design, or idea into shared understanding before anyone implements it. Challenge the thinking, not the person.

## Boundaries

- This is an interview, not an implementation workflow.
- Read code, documents, history, and other available sources when they can establish facts, but do not edit files, run mutating operations, start implementation, or perform the plan being discussed.
- Do not treat completion of the interview as authorization to implement. The user must request implementation separately after the skill ends.
- Do not create a session file unless the user explicitly asks to persist the interview. If persistence is requested, agree on the path and keep the file current after every answer.
- Stay within the domain the user chose. Flag an adjacent decision before crossing into it.

## Establish the ground truth

Before asking a substantive question:

1. Identify the plan, decision, or artifact being examined from the prompt and conversation.
2. Inspect relevant repository instructions, code, documents, tests, issues, logs, or supplied materials. Never ask the user for a fact that can be found safely from available sources.
3. Separate what is verified from what is merely claimed or assumed. Cite the local source when a discovered fact materially shapes a question.
4. If the target remains genuinely unclear after inspection, ask one short scope question and recommend the narrowest useful interpretation.

## Maintain a decision tree

Model the topic as a tree of dependent decisions. Keep an internal ledger containing:

- verified facts and their sources;
- assumptions that still need validation;
- decisions and their rationale;
- risks and failure modes;
- deferred items and their consequences;
- unresolved questions.

Prioritize the next branch by impact, uncertainty, dependency centrality, and reversal cost. Resolve prerequisite decisions before asking about choices that depend on them. Reopen a decision when later evidence invalidates one of its premises.

Do not dump the full tree on the user unless they ask for it. Use it to choose the single most consequential next question.

## Interview one question at a time

Each turn should contain exactly one decision question. Include:

1. the relevant verified context or tension, briefly;
2. one clearly worded question;
3. a concrete recommended answer;
4. the principal trade-off or consequence of that recommendation.

Phrase the question so that accepting the recommendation is unambiguous. Prefer a small set of real alternatives when useful. Do not ask compound questions whose parts could reasonably receive different answers.

After the user answers:

1. Record the answer in the ledger as a decision, assumption, deferral, or unresolved item.
2. State a one-sentence confirmation when interpretation matters.
3. Recompute the decision tree.
4. Ask exactly one next question.

Support these short control replies without requiring them:

- `accept`: adopt the recommendation.
- `change: ...`: record the user's alternative and rationale.
- `unknown`: choose a reversible default or define the cheapest useful way to learn.
- `skip`: defer the decision and record any material consequence.
- `summary`: show the current ledger, then continue with one next question.
- `stop`: end immediately with the best available decision brief.

Be direct and collegial. Explain disagreement instead of hiding it in a vague question. Accept a sound answer; do not manufacture conflict to prolong the session.

## ELAND-specific route

When working in the ELAND repository, read the applicable `AGENTS.md` and current executable behavior before relying on older design documents.

For a proposed change to motives, projects, production, knowledge, social relations, institutions, or civilization observers, make the user resolve the earliest uncertain link in:

```text
pressure -> perception -> memory -> need -> project -> plan
-> legal action -> consequence -> learning -> transmission -> institution
```

Check that the proposal preserves these boundaries:

- authoritative simulation facts come from domain rules and replayable events;
- projection, reporting, UI, and decoration do not create simulation facts;
- agents do not read hidden recipes, global maps, observer metrics, or other imperceptible information;
- desired narratives, civilization numbers, and outcomes are not hard-coded;
- success evidence uses matched seeds and an appropriate causal timescale rather than one favorable run.

Do not run evolution experiments or change simulation rules during this interview. Once the decision brief is approved, recommend a separate `$iterate-emergent-civilization` task when evidence-backed rule iteration is actually required.

## Completion

Do not end merely because the user accepted one recommendation. Continue while a high-impact branch remains silently assumed or depends on an unresolved premise.

Propose closing the interview when:

- the objective and non-goals are explicit;
- high-impact and hard-to-reverse decisions are resolved;
- important assumptions and failure modes are visible;
- success can be judged with concrete evidence;
- remaining uncertainty is local, inexpensive, or reversible.

Unless the user already said `stop`, ask one final confirmation question and recommend closing. After confirmation, provide a concise decision brief containing:

- objective and non-goals;
- verified facts;
- decisions with rationale;
- assumptions and validation needs;
- risks and mitigations;
- deferred questions;
- acceptance evidence;
- the single recommended next action.

End there. Do not implement the plan in the same skill invocation.
