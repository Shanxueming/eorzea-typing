const KEY = 'eorzea:device-id';

/**
 * ★ 不能只靠 crypto.randomUUID——线上是明文 HTTP(非标端口,没走 TLS,
 *   见 DEPLOY.md),不满足浏览器的 secure context 要求,那种环境下
 *   crypto.randomUUID 压根不存在,调用就抛异常。这里不需要密码学强度,
 *   够用来"数有多少台不同设备"就行,退化成拼接随机数完全没问题。
 */
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 纯匿名的本机随机串,只用来给管理后台的用量统计当"这是同一台设备"的依据——
 * 不绑账号、不上传除了这个统计接口以外的任何地方。
 */
export function deviceId(): string {
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id) {
      id = randomId();
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // 无痕模式写不进去——退化成每次都是"新设备",统计会偏高但不影响游戏
    return randomId();
  }
}
