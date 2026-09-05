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

/**
 * One slow model reconsideration per living person-month before rolling
 * deductions. This ratio never gates local planning or intent execution.
 */
export const ORDINARY_DECISION_PERSON_MONTHS = 1;

export function rollingDecisionUsage<T extends MonthlyDecisionUsage>(ledgers: T[], elapsedMonths: number): T[] {
  const firstMonth = Math.max(1, elapsedMonths - 10);
  return ledgers.filter((ledger) => ledger.atMonth >= firstMonth);
}

export function availableModelContexts(ledgers: MonthlyDecisionUsage[], livingAgents: number): number {
  // This is remote enhancement capacity, not a character action budget.
  const personMonths = ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0) + livingAgents;
  const used = ledgers.reduce((sum, ledger) => sum + (ledger.ordinaryModelContexts ?? ledger.modelContexts), 0);
  return Math.max(0, Math.floor(personMonths / ORDINARY_DECISION_PERSON_MONTHS) - used);
}

export function availableModelTokens(ledgers: MonthlyDecisionUsage[], livingAgents: number, tokensPerContext: number): number {
  // Exhausting the token allowance falls back to deterministic local planning.
  const personMonths = ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0) + livingAgents;
  const used = ledgers.reduce((sum, ledger) => sum + (ledger.ordinaryChargedTokens ?? ledger.chargedTokens), 0);
  return Math.max(0, Math.floor(personMonths / ORDINARY_DECISION_PERSON_MONTHS) * tokensPerContext - used);
}
