export interface MonthlyDecisionUsage {
  atMonth: number;
  livingAgents: number;
  modelContexts: number;
  chargedTokens: number;
  /** Ordinary contexts consume the rolling person-month budget. Older saves charge every context. */
  ordinaryModelContexts?: number;
  /** Bootstrap, emergency, required-response, and fulfillment contexts are audited but not budgeted. */
  exemptModelContexts?: number;
  /** Token charge attributable to ordinary contexts only. */
  ordinaryChargedTokens?: number;
}

export const ORDINARY_DECISION_PERSON_MONTHS = 3;

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
