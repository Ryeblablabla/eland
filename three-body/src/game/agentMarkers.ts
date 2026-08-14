import type { IntentView, SocietyAgent } from './societyContract';

/**
 * 人物地图渲染层：把人物的姓名、移动朝向、身体状态与当前意图
 * 外化到地表地图上。纯绘制函数，不触碰模拟状态。
 */

export interface AgentMarkerDraw {
  x: number;      // 画布坐标（px）
  y: number;
  dirX: number;   // 移动方向（世界格单位，未归一化；≈0 表示静止）
  dirY: number;
  scale: number;  // 当前格边长（px，随缩放变化）
  selected: boolean;
  speaking: boolean;
  intentKind?: IntentView['actionKind'];
}

/** 身体状态 → 状态环颜色（脱水是三体世界的头等状态，独立成蓝） */
function statusColor(agent: SocietyAgent, selected: boolean, speaking: boolean): string {
  if (selected) return '#fde68a';
  if (speaking) return '#fbbf24';
  if (agent.state === 'dehydrated') return '#60a5fa';
  const health = agent.body.health;
  if (health >= 60) return '#34d399';
  if (health >= 30) return '#fbbf24';
  return '#f87171';
}

/** 意图符号：行动种类的极简图形语言（全部 canvas 路径，无 emoji） */
function drawIntentGlyph(
  ctx: CanvasRenderingContext2D,
  kind: IntentView['actionKind'],
  cx: number,
  cy: number,
  r: number,
  dirX: number,
  dirY: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(253,230,138,0.95)';
  ctx.fillStyle = 'rgba(253,230,138,0.95)';
  ctx.lineWidth = Math.max(1, r * 0.24);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (kind) {
    case 'move': {
      // 三角箭头，指向移动方向（静止时朝上）
      const angle = dirX || dirY ? Math.atan2(dirY, dirX) : -Math.PI / 2;
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(-r * 0.7, r * 0.62);
      ctx.lineTo(-r * 0.7, -r * 0.62);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'communicate': {
      // 对话气泡
      ctx.beginPath();
      ctx.rect(-r, -r * 0.7, r * 1.9, r * 1.25);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 0.15, r * 0.55);
      ctx.lineTo(-r * 0.45, r * 1.05);
      ctx.lineTo(r * 0.3, r * 0.55);
      ctx.stroke();
      break;
    }
    case 'transfer': {
      // 双向箭头（交换）
      ctx.beginPath();
      ctx.moveTo(-r, -r * 0.28);
      ctx.lineTo(r * 0.8, -r * 0.28);
      ctx.moveTo(r * 0.35, -r * 0.62);
      ctx.lineTo(r * 0.85, -r * 0.28);
      ctx.lineTo(r * 0.35, r * 0.06);
      ctx.moveTo(r, r * 0.38);
      ctx.lineTo(-r * 0.8, r * 0.38);
      ctx.moveTo(-r * 0.35, r * 0.04);
      ctx.lineTo(-r * 0.85, r * 0.38);
      ctx.lineTo(-r * 0.35, r * 0.72);
      ctx.stroke();
      break;
    }
    case 'attend': {
      // 观察之眼：圆环 + 瞳
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: {
      // act：四角星（行动）
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.26, -r * 0.26);
      ctx.lineTo(r, 0);
      ctx.lineTo(r * 0.26, r * 0.26);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.26, r * 0.26);
      ctx.lineTo(-r, 0);
      ctx.lineTo(-r * 0.26, -r * 0.26);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * 绘制一名人物的完整标记：状态环 + 本体 + 朝向针 + 姓名标签 + 意图符号。
 * 调用方负责在每帧对每个 agent 调用；函数内部 save/restore，不污染上下文。
 */
export function drawAgentMarker(
  ctx: CanvasRenderingContext2D,
  agent: SocietyAgent,
  d: AgentMarkerDraw,
): void {
  const dead = agent.state === 'dead';
  const radius = Math.max(3, Math.min(d.selected ? d.scale * 0.36 : d.scale * 0.27, 10));

  ctx.save();

  // ---- 状态环（健康 / 脱水 / 选中 / 说话）----
  if (!dead) {
    ctx.beginPath();
    ctx.strokeStyle = statusColor(agent, d.selected, d.speaking);
    ctx.lineWidth = Math.max(1.2, Math.min(2.4, d.scale * 0.09));
    ctx.arc(d.x, d.y, radius + ctx.lineWidth * 1.6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ---- 本体 ----
  ctx.beginPath();
  ctx.fillStyle = dead ? '#424852' : d.selected ? '#fde68a' : d.speaking ? '#fbbf24' : '#f2efe6';
  ctx.arc(d.x, d.y, radius, 0, Math.PI * 2);
  ctx.fill();

  if (dead) {
    // 死亡：✕ 标记，无朝向与标签
    const r = radius * 0.5;
    ctx.strokeStyle = '#0b0e13';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(d.x - r, d.y - r);
    ctx.lineTo(d.x + r, d.y + r);
    ctx.moveTo(d.x + r, d.y - r);
    ctx.lineTo(d.x - r, d.y + r);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // ---- 朝向针（移动方向）----
  const dirLen = Math.hypot(d.dirX, d.dirY);
  if (dirLen > 1e-4) {
    const nx = d.dirX / dirLen;
    const ny = d.dirY / dirLen;
    const pin = Math.max(4, Math.min(8, d.scale * 0.3));
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(248,240,220,0.9)';
    ctx.lineWidth = Math.max(1.4, Math.min(2.2, d.scale * 0.08));
    ctx.lineCap = 'round';
    ctx.moveTo(d.x + nx * (radius + 2), d.y + ny * (radius + 2));
    ctx.lineTo(d.x + nx * (radius + 2 + pin), d.y + ny * (radius + 2 + pin));
    ctx.stroke();
  }

  // ---- 姓名标签（缩放过小只保留选中/说话者，防拥挤）----
  const showLabel = d.scale >= 10 || d.selected || d.speaking;
  if (showLabel) {
    const fontSize = Math.max(10, Math.min(13, d.scale * 0.42));
    ctx.font = `500 ${fontSize}px ui-sans-serif, system-ui, "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const labelY = d.y - radius - 6;
    const textW = ctx.measureText(agent.name).width;
    const pad = 3;
    // 半透明背板保证任何地形上可读
    ctx.fillStyle = 'rgba(5,8,12,0.62)';
    ctx.fillRect(d.x - textW / 2 - pad, labelY - fontSize - pad * 1.6, textW + pad * 2, fontSize + pad * 2.4);
    ctx.fillStyle = d.selected || d.speaking ? '#fde68a' : 'rgba(226,232,240,0.92)';
    ctx.fillText(agent.name, d.x, labelY);
    // ---- 意图符号（标签右上）----
    if (d.intentKind) {
      drawIntentGlyph(ctx, d.intentKind, d.x + textW / 2 + pad + fontSize * 0.55, labelY - fontSize * 0.55, fontSize * 0.42, d.dirX, d.dirY);
    }
  }

  ctx.restore();
}
