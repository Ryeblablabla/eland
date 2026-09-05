import { materialDefinition } from '../material';
import type { SimulationState } from '../model';

/** Player and memory text describe committed effects, not the resolver's wish. */
export function worldInteractionResult(
  state: SimulationState,
  applied: readonly Record<string, unknown>[],
): string {
  const results: string[] = [];
  for (const effect of applied) {
    const material = typeof effect.materialId === 'number' ? materialDefinition(effect.materialId).name : '材料';
    if (effect.kind === 'consume') results.push(`投入了${effect.quantity}份${material}`);
    else if (effect.kind === 'produce') results.push(`得到${effect.quantity}份${material}，${effect.destination === 'inventory' ? '已放入随身物资' : '已放在地面'}`);
    else if (effect.kind === 'relocate') results.push(`实际搬动了${effect.quantity}份${material}`);
    else if (effect.kind === 'replace-voxel') results.push(`目标位置变为${material}`);
    else if (effect.kind === 'assemble' || effect.kind === 'modify-structure') {
      const work = state.world.works?.find((item) => item.id === effect.workId);
      results.push(`${effect.kind === 'assemble' ? '搭成' : '改造'}了“${work?.summary ?? '组合造物'}”`);
    } else if (effect.kind === 'move-self') results.push('已实际到达目标附近的落脚位置');
    else if (effect.kind === 'body') {
      const person = state.people.find((item) => item.id === effect.personId);
      const field = effect.field === 'health' ? '健康' : effect.field === 'hydration' ? '水分' : '营养';
      results.push(`${person?.name ?? '本人'}的${field}实际变化${Number(effect.delta) >= 0 ? '+' : ''}${effect.delta}`);
    } else if (effect.kind === 'knowledge') results.push(`记下本人的观察或判断：“${effect.summary}”`);
    else if (effect.kind === 'world-state') results.push(`在对象上记录了${effect.stateKey ?? '现场状态'}：${effect.stateValue ?? effect.summary}`);
    else if (effect.kind === 'bond-animal') results.push('完成了与动物的接触，留下实际反应记录');
    else if (effect.kind === 'relation') results.push('本人对这段关系的感受发生变化');
  }
  return results.length ? results.join('；') : '完成了本次尝试，没有产生可记录的世界变化';
}
