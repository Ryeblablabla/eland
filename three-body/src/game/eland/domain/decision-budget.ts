export interface MonthlyDecisionUsage {
  atMonth: number;
  livingAgents: number;
  modelContexts: number;
  chargedTokens: number;
}

export function rollingDecisionUsage<T extends MonthlyDecisionUsage>(ledgers: T[], elapsedMonths: number): T[] {
  const firstMonth = Math.max(1, elapsedMonths - 10);
  return ledgers.filter((ledger) => ledger.atMonth >= firstMonth);
}

export function availableModelContexts(ledgers: MonthlyDecisionUsage[], livingAgents: number): number {
  const personMonths = ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0) + livingAgents;
  const used = ledgers.reduce((sum, ledger) => sum + ledger.modelContexts, 0);
  return Math.max(0, Math.floor(personMonths / 12) - used);
}

export function availableModelTokens(ledgers: MonthlyDecisionUsage[], livingAgents: number, tokensPerContext: number): number {
  const personMonths = ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0) + livingAgents;
  const used = ledgers.reduce((sum, ledger) => sum + ledger.chargedTokens, 0);
  return Math.max(0, Math.floor(personMonths / 12) * tokensPerContext - used);
}
