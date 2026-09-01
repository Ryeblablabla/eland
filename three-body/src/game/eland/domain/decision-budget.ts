export interface MonthlyDecisionUsage {
  atMonth: number;
  livingAgents: number;
  modelContexts: number;
  chargedTokens: number;
  /** Ordinary contexts consume the rolling person-month budget. Older saves charge every context. */
  ordinaryModelContexts?: number;
  /** Contexts explicitly exempted by the caller are audited but not budgeted. */
  exemptModelContexts?: number;
  /** Token charge attributable to ordinary contexts only. */
  ordinaryChargedTokens?: number;
}

/** One slow cognitive turn per living person-month before rolling deductions. */
export const ORDINARY_DECISION_PERSON_MONTHS = 1;

/** Local rule planning is cheap, but bounded so short intents cannot churn through all 15 ticks. */
export const ORDINARY_LOCAL_DELIBERATIONS_PER_PERSON_MONTH = 2;

export function rollingDecisionUsage<T extends MonthlyDecisionUsage>(ledgers: T[], elapsedMonths: number): T[] {
  const firstMonth = Math.max(1, elapsedMonths - 10);
  return ledgers.filter((ledger) => ledger.atMonth >= firstMonth);
}

export function availableModelContexts(ledgers: MonthlyDecisionUsage[], livingAgents: number): number {
  const personMonths = ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0) + livingAgents;
  const used = ledgers.reduce((sum, ledger) => sum + (ledger.ordinaryModelContexts ?? ledger.modelContexts), 0);
  return Math.max(0, Math.floor(personMonths / ORDINARY_DECISION_PERSON_MONTHS) - used);
}

export function availableModelTokens(ledgers: MonthlyDecisionUsage[], livingAgents: number, tokensPerContext: number): number {
  const personMonths = ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0) + livingAgents;
  const used = ledgers.reduce((sum, ledger) => sum + (ledger.ordinaryChargedTokens ?? ledger.chargedTokens), 0);
  return Math.max(0, Math.floor(personMonths / ORDINARY_DECISION_PERSON_MONTHS) * tokensPerContext - used);
}
