import type { ActionOption, RepresentationInput, SocialProposal } from '../domain/action';
import { classifyActionOption } from '../domain/action-option-semantics';
import { agreementById, agreementIsKnownTo, agreementResponseDeadline } from '../domain/agreement';
import { intentById } from '../domain/state-index';
import { activeMembership } from '../domain/collective';
import type { MentalAct } from '../domain/mental-act';
import type { DecisionContext } from '../domain/model';
import type { NativeOperationCompilation, NativeOperationCompilationProblem } from '../domain/native-operation';

type FrozenSpeech = Pick<MentalAct, 'utterance' | 'delivery' | 'speechIntent' | 'sourceEventIds'>;

function proposalAuthor(proposal: SocialProposal): string {
  return proposal.kind === 'assist' ? proposal.requesterId : proposal.kind === 'exchange' ? proposal.offererId : proposal.proposerId;
}

/** Compile the speaker's frozen declaration. World cannot add a proposal, reply, or new words. */
export function compileNativeSpeechOperation(context: DecisionContext, mind: FrozenSpeech, id: string): NativeOperationCompilation {
  const { state, person } = context;
  const atMonth = context.decisionMonth ?? state.clock.elapsedMonths + 1;
  const originId = context.continuingPlan?.sourceDecisionEventId;
  if (originId && [...state.world.past, ...(context.currentMonthEvents ?? [])].some((event) => {
    if (event.kind !== 'action' || event.who !== person.id || event.status !== 'completed' || event.action.kind !== 'talk') return false;
    const intent = event.intentId ? intentById(state, event.intentId) : undefined;
    return event.diff.languageSourceEventId === originId
      || Boolean(intent && (intent.planSourceDecisionEventId ?? intent.sourceDecisionEventId) === originId);
  })) {
    return { ok: false, problem: { code: 'invalid-operation', message: '这份冻结原话已经执行为一次真实发言；继续身体行动或等待新的本人决定，不重播同一句发言。' } };
  }
  if (!mind.utterance.trim()) return { ok: false, problem: { code: 'missing-evidence', message: '没有本人本轮形成的原话，World 不能代写发言。', fields: ['utterance'] } };
  const representationId = `${id}:representation`;
  const ordinary: RepresentationInput = { id: representationId, kind: 'claim', summary: mind.utterance };
  let meaning: RepresentationInput = ordinary;
  let feedback: NativeOperationCompilationProblem | undefined;
  const sourceFactIds = [...mind.sourceEventIds];
  const problem = (message: string, fields?: string[]) => {
    feedback = { code: 'missing-evidence', message: `${message}；保留本人原话，本次没有创建或改变协议。`, ...(fields ? { fields } : {}) };
  };
  const speech = mind.speechIntent;
  if (speech?.kind === 'proposal') {
    const proposal = speech.proposal;
    if (!proposal) problem('提议缺少明确条款，不从动作菜单补全', speech.compilationProblems ?? ['terms']);
    else if (proposal.kind !== speech.proposalKind || proposalAuthor(proposal) !== person.id) problem('提议的作者或类型不对应本人的声明', ['proposal.author', 'proposal.kind']);
    else if (proposal.expiresAtMonth !== undefined && proposal.expiresAtMonth < atMonth) problem('本人声明的提议期限已经过去，不能代为延长', ['expiresAtMonth']);
    else {
      const namedParties = proposal.kind === 'joint-action' ? proposal.inviteeIds : proposal.kind === 'assist' ? [proposal.helperId]
        : proposal.kind === 'membership' || proposal.kind === 'decision-rule' || proposal.kind === 'mandate'
          ? [proposal.partnerId, ...proposal.requiredApproverIds]
          : [proposal.partnerId];
      const knownParties = namedParties.every((partyId) => (partyId === person.id || speech.counterpartIds.includes(partyId))
        && state.people.some((candidate) => candidate.id === partyId));
      const collective = 'collectiveId' in proposal ? state.collectives.find((candidate) => candidate.id === proposal.collectiveId) : undefined;
      if (!knownParties) problem('提议中的参与者没有与本人声明的对象一致绑定', ['counterpartHandles']);
      else if ('collectiveId' in proposal && (!collective || !activeMembership(collective, person.id))) problem('点名的共同体不是本人当前所属的真实共同体', ['collectiveHandle']);
      else if (proposal.kind === 'permission' && (proposal.grantorId !== person.id || proposal.granteeId !== proposal.partnerId)) problem('只能声明本人给真实对方的许可，不能代别人授权', ['permission.parties']);
      else if (proposal.kind === 'mandate' && !collective?.decisionRules.some((rule) => rule.id === proposal.decisionRuleId)) problem('点名的决策规则不属于该共同体', ['decisionRuleHandle']);
      else if (proposal.kind === 'mandate' && proposal.projectId && !state.projects.some((project) => project.id === proposal.projectId)) problem('点名的项目不存在', ['projectHandle']);
      else {
        meaning = { id: representationId, kind: proposal.kind === 'assist' ? 'request' : 'offer', summary: mind.utterance, proposal: structuredClone(proposal) };
        if (collective) sourceFactIds.push(...collective.sourceEventIds);
      }
    }
  } else if (speech?.kind === 'prediction') {
    if (speech.prediction) meaning = { id: representationId, kind: 'prediction', summary: mind.utterance, prediction: structuredClone(speech.prediction) };
    else problem('预测缺少本人明确说定的纪元、月份或容差，不能从菜单代选预测', speech.compilationProblems ?? ['prediction']);
  } else if (speech?.kind === 'request-information') {
    meaning = { id: representationId, kind: 'request', summary: mind.utterance };
  } else if (speech?.kind === 'share-knowledge') {
    const knowledge = person.knowledge.find((candidate) => candidate.id === speech.referenceId);
    if (!knowledge) problem('本人没有点名的知识或经验', ['referenceHandle']);
    else {
      meaning = { id: representationId, kind: 'claim', summary: mind.utterance, factId: knowledge.id };
      sourceFactIds.push(...knowledge.sourceEventIds);
    }
  } else if (speech?.kind === 'accept' || speech?.kind === 'reject' || speech?.kind === 'end-agreement') {
    const agreement = agreementById(state, speech.referenceId);
    if (!agreement || !agreementIsKnownTo(agreement, person.id)) problem('点名的协议没有本人真实参与关系', ['referenceHandle']);
    else if (speech.kind === 'end-agreement') {
      const jointCanEnd = agreement.proposal.kind === 'joint-action'
        && (agreement.status === 'proposed' || agreement.status === 'active')
        && (person.id === agreement.proposerId || agreement.acceptedByPersonIds.includes(person.id));
      if (!jointCanEnd && (agreement.status !== 'active' || agreement.proposal.kind === 'joint-action')) problem('点名的协议当前并未生效，或本人尚未参与，不能报告已经解除', ['referenceHandle']);
      else meaning = { id: representationId, kind: 'revoke-agreement', referenceId: agreement.id, summary: mind.utterance };
    } else if (agreement.status !== 'proposed' || !agreement.requiredResponderIds.includes(person.id)
      || agreement.acceptedByPersonIds.includes(person.id) || agreement.rejectedByPersonIds.includes(person.id)
      || agreementResponseDeadline(agreement, person.id) < atMonth) {
      problem('这份提议当前没有等待本人的新回应；不重复同意或代其他人回应', ['referenceHandle']);
    } else meaning = { id: representationId, kind: speech.kind, referenceId: agreement.id, summary: mind.utterance };
    if (agreement && meaning !== ordinary) sourceFactIds.push(...agreement.sourceEventIds);
  } else if (speech?.kind === 'revoke-permission') {
    const permission = state.permissions.find((candidate) => candidate.id === speech.referenceId);
    if (!permission || permission.grantorId !== person.id || permission.status !== 'active') problem('点名的有效许可不是本人授出的，不能代他人撤销', ['referenceHandle']);
    else {
      meaning = { id: representationId, kind: 'revoke', permissionId: permission.id, summary: mind.utterance };
      sourceFactIds.push(...permission.sourceEventIds);
    }
  } else if (speech?.kind === 'leave-collective') {
    const collective = state.collectives.find((candidate) => candidate.id === speech.referenceId);
    if (!collective || !activeMembership(collective, person.id)) problem('本人当前并非点名共同体的成员，不能报告已经退出', ['referenceHandle']);
    else {
      meaning = { id: representationId, kind: 'withdraw', collectiveId: collective.id, summary: mind.utterance };
      sourceFactIds.push(...collective.sourceEventIds);
    }
  }
  const option: ActionOption = {
    id, summary: `发言：${mind.utterance}`,
    reason: feedback?.message ?? '执行本人本轮已经形成的语言含义；他人是否听见、理解或接受由独立事件决定',
    goal: { kind: 'representation-made', representationId },
    nextAction: { kind: 'talk', delivery: mind.delivery, speakerMeaning: meaning },
    estimatedDuration: 'one-month', sourceFactIds: [...new Set(sourceFactIds)], domain: 'social',
  };
  return { ok: true, option: classifyActionOption(option), ...(feedback ? { feedback } : {}) };
}
