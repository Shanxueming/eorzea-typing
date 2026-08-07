/**
 * 结算页「分享战绩截图」——本地画一张 PNG,优先写进剪贴板,不行就退回下载。
 *
 * ★ 线上是明文 HTTP 非标端口(没走 TLS,见 DEPLOY.md),不满足浏览器的
 *   secure context 要求。这种环境下 navigator.clipboard 本身可能就是
 *   undefined,或者存在但没有 write() —— 和 deviceId.ts 踩过的
 *   crypto.randomUUID 是同一类坑,这次直接把降级方案写进来,不用等上线
 *   才发现剪贴板用不了。
 */

export interface ShareFields {
  /** 账号展示名,含 # 数字,如「花容月貌的莫古力#417」 */
  displayId: string;
  track: string;
  durationText: string;
  cpm: number;
  /** null 表示这条赛道/这一轮没有可比的排名数据 */
  rank: number | null;
  total: number;
  beatPercent: number | null;
}

export type ShareOutcome =
  | { status: 'copied' }
  | { status: 'downloaded' }
  | { status: 'error'; message: string };

const FONT = "'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";

function drawCard(fields: ShareFields): HTMLCanvasElement {
  const scale = 2;
  const W = 720;
  const H = 480;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context 不可用');
  ctx.scale(scale, scale);

  // 背景 + 描边,配色跟游戏内一致(tokens.css 的 --color-bg / --color-crystal)
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#182241');
  bg.addColorStop(1, '#0b1020');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#7fd8e8';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, W - 20, H - 20);

  ctx.fillStyle = '#ffd47f';
  ctx.font = `bold 26px ${FONT}`;
  ctx.fillText('最终幻想14打字通 · 战绩', 40, 60);

  ctx.fillStyle = '#8a97b5';
  ctx.font = `14px ${FONT}`;
  ctx.fillText(fields.track, 40, 88);

  ctx.fillStyle = '#7fd8e8';
  ctx.font = `bold 22px ${FONT}`;
  ctx.fillText(fields.displayId, 40, 128);

  ctx.strokeStyle = 'rgba(127, 216, 232, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 148);
  ctx.lineTo(W - 40, 148);
  ctx.stroke();

  type Row = [string, string];
  const rows: Row[] = [
    ['本局时长', fields.durationText],
    ['CPM', String(fields.cpm)],
  ];
  if (fields.beatPercent !== null) {
    rows.push(['本局超越', `${fields.beatPercent}% 的玩家`]);
  } else {
    rows.push(['本局超越', '本轮第一位挑战者']);
  }
  rows.push(['排行榜排名', fields.rank !== null ? `第 ${fields.rank} 位 / 共 ${fields.total} 人` : '这条赛道暂无排名统计']);

  let y = 200;
  const colX = [40, 380];
  rows.forEach(([label, value], i) => {
    const x = colX[i % 2];
    if (i % 2 === 0 && i > 0) y += 100;
    ctx.fillStyle = '#8a97b5';
    ctx.font = `14px ${FONT}`;
    ctx.fillText(label, x, y);
    ctx.fillStyle = '#e9f4f7';
    ctx.font = `bold 28px ${FONT}`;
    ctx.fillText(value, x, y + 34);
  });

  ctx.fillStyle = '#8a97b5';
  ctx.font = `12px ${FONT}`;
  ctx.fillText(new Date().toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }), 40, H - 28);

  return canvas;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('画布导出失败'));
    }, 'image/png');
  });
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 生成战绩截图并尝试复制到剪贴板;剪贴板不可用(非安全上下文/浏览器不支持/
 * 用户拒绝权限)时自动退回下载,调用方不需要分别处理这两条路径的失败。
 */
export async function shareResultImage(fields: ShareFields): Promise<ShareOutcome> {
  let blob: Blob;
  try {
    blob = await toBlob(drawCard(fields));
  } catch (e) {
    return { status: 'error', message: String(e) };
  }

  const filename = `最终幻想14打字通-战绩-${fields.displayId.replace(/[#\s]/g, '')}.png`;

  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      throw new Error('clipboard API 不可用');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return { status: 'copied' };
  } catch {
    // 剪贴板这条路走不通(常见于非 HTTPS、Safari 权限策略、无痕模式),
    // 图已经画好了,直接退回下载,别让用户空手而归。
    try {
      download(blob, filename);
      return { status: 'downloaded' };
    } catch (e) {
      return { status: 'error', message: String(e) };
    }
  }
}
