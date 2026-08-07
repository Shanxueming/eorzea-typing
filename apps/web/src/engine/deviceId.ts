const KEY = 'eorzea:device-id';

/**
 * 纯匿名的本机随机串,只用来给管理后台的用量统计当"这是同一台设备"的依据——
 * 不绑账号、不上传除了这个统计接口以外的任何地方。
 */
export function deviceId(): string {
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // 无痕模式写不进去——退化成每次都是"新设备",统计会偏高但不影响游戏
    return crypto.randomUUID();
  }
}
