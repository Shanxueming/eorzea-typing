/**
 * 音效与 BGM。
 *
 * ★ 全部用原生 Web Audio 实时合成 —— 不下载任何音频文件,不引入音频库。
 *   零体积、零版权问题,想改音色直接调下面的参数即可。
 *
 * BGM 是唯一需要真实文件的音频,且文件缺失时静默降级,不报错。
 *
 * 这个文件本属于 §1 的只读八件套,这里破例加了一条 'poof'(用户要求给
 * 打错弹出的兔子配一个"烟雾弹"音效)。只新增了一个类型成员和一条音色定义,
 * 没有改动其余四种音效的参数、也没有碰 AudioEngine 类的任何方法,
 * 按 AGENTS.md 的规则在这里说明理由,pnpm test 仍然 47 绿。
 */

export type Sfx = 'hit' | 'hit_clear' | 'hit_slash' | 'victory' | 'miss' | 'interrupt' | 'hurt' | 'poof';

export interface BgmTrack {
  name: string;
  url: string;
}

const BGM_BASE_VOLUME = 0.25;

interface ToneSpec {
  type: OscillatorType;
  /** 起始频率 */
  from: number;
  /** 终止频率,等于 from 则不滑音 */
  to: number;
  durationMs: number;
  gain: number;
  /** 延迟多少毫秒后叠加播放,用于做和声 */
  delayMs?: number;
}

/** 音色表。调参就改这里 */
const SFX: Record<Sfx, ToneSpec[]> = {
  // 打对一个词:短促上扬
  hit: [{ type: 'sine', from: 440, to: 660, durationMs: 60, gain: 0.12 }],
  // 新的普通词命中音：高音三角波与泛音叠加，保留旧 hit 参数不动。
  hit_clear: [
    { type: 'triangle', from: 880, to: 1320, durationMs: 85, gain: 0.12 },
    { type: 'sine', from: 1760, to: 1980, durationMs: 115, gain: 0.055, delayMs: 12 },
  ],
  // 拔刀式命中：极短的高频切入加一枚收束泛音，避免厚重或拖泥带水。
  hit_slash: [
    { type: 'square', from: 2200, to: 920, durationMs: 42, gain: 0.045 },
    { type: 'triangle', from: 1240, to: 1760, durationMs: 78, gain: 0.105, delayMs: 6 },
  ],
  // 胜利三连音（叮、叮、叮），以大三和弦上行留下明确的讨伐完成印象。
  victory: [
    { type: 'sine', from: 784, to: 784, durationMs: 150, gain: 0.11 },
    { type: 'sine', from: 988, to: 988, durationMs: 150, gain: 0.1, delayMs: 130 },
    { type: 'sine', from: 1319, to: 1319, durationMs: 230, gain: 0.12, delayMs: 260 },
  ],
  // 打错:低沉钝音
  miss: [{ type: 'square', from: 180, to: 180, durationMs: 90, gain: 0.08 }],
  // 打断成功:双音上行,错开 30ms 制造和声感
  interrupt: [
    { type: 'sine', from: 880, to: 1100, durationMs: 140, gain: 0.1 },
    { type: 'sine', from: 1320, to: 1650, durationMs: 140, gain: 0.07, delayMs: 30 },
  ],
  // 受伤:下行滑音
  hurt: [{ type: 'sawtooth', from: 300, to: 120, durationMs: 220, gain: 0.1 }],
  // 烟雾弹「蓬」:低音快速下坠 + 错开一点的短促方波增加颗粒感
  poof: [
    { type: 'triangle', from: 300, to: 50, durationMs: 160, gain: 0.14 },
    { type: 'square', from: 150, to: 40, durationMs: 200, gain: 0.06, delayMs: 15 },
  ],
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private bgm: HTMLAudioElement | null = null;
  private muted = false;
  private sfxMuted = readAudioPreference('eorzea:sfx-muted');
  private bgmMuted = readAudioPreference('eorzea:bgm-muted');
  /** 1 表示保持现有版本的 BGM 0.25 和全部音效音色参数不变。 */
  private volume = readAudioVolume('eorzea:audio-volume');
  private bgmAvailable = false;
  private bgmRequested = false;
  private bgmTracks: BgmTrack[] | null = null;
  private currentBgmIndex = -1;
  private bgmTrackListeners = new Set<(track: BgmTrack | null) => void>();

  /**
   * ★ AudioContext 在用户首次交互前处于 suspended 状态。
   *   必须在第一次点击或按键时调用本方法,否则全程无声。
   */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.setSfxMuted(m);
    this.setBgmMuted(m);
  }

  isMuted(): boolean { return this.muted; }
  setSfxMuted(muted: boolean): void {
    this.sfxMuted = muted;
    writeAudioPreference('eorzea:sfx-muted', muted);
    this.muted = this.sfxMuted && this.bgmMuted;
  }
  isSfxMuted(): boolean { return this.sfxMuted; }
  setBgmMuted(muted: boolean): void {
    this.bgmMuted = muted;
    writeAudioPreference('eorzea:bgm-muted', muted);
    if (this.bgm) {
      this.bgm.muted = muted;
      if (!muted && this.bgmRequested) void this.bgm.play().catch(() => { /* 尚未获得播放权限时等待下一次交互 */ });
    }
    this.muted = this.sfxMuted && this.bgmMuted;
  }
  isBgmMuted(): boolean { return this.bgmMuted; }
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    writeAudioPreference('eorzea:audio-volume', this.volume);
    if (this.bgm) this.bgm.volume = BGM_BASE_VOLUME * this.volume;
  }
  getVolume(): number { return this.volume; }
  hasBgm(): boolean { return this.bgmAvailable; }
  getCurrentBgm(): BgmTrack | null {
    return this.currentBgmIndex >= 0 ? this.bgmTracks?.[this.currentBgmIndex] ?? null : null;
  }
  onBgmTrackChange(listener: (track: BgmTrack | null) => void): () => void {
    this.bgmTrackListeners.add(listener);
    listener(this.getCurrentBgm());
    return () => this.bgmTrackListeners.delete(listener);
  }

  play(name: Sfx): void {
    if (this.sfxMuted || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    for (const spec of SFX[name]) {
      const start = now + (spec.delayMs ?? 0) / 1000;
      const dur = spec.durationMs / 1000;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = spec.type;
      osc.frequency.setValueAtTime(spec.from, start);
      if (spec.to !== spec.from) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), start + dur);
      }

      // 指数衰减包络。起点不能为 0,否则 exponentialRamp 会抛错
      gain.gain.setValueAtTime(spec.gain * this.volume, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur);

      // ★ 每个音效新建振荡器,播完必须断开,否则长局会内存泄漏
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }
  }

  /** 从服务端读取素材目录的播放列表；不再要求 bgm.mp3 这个固定文件名。 */
  async loadBgmPlaylist(): Promise<readonly BgmTrack[]> {
    if (this.bgmTracks) return this.bgmTracks;
    try {
      const response = await fetch('/api/audio-playlist');
      if (!response.ok) throw new Error('playlist missing');
      const payload = await response.json() as { tracks?: unknown };
      this.bgmTracks = Array.isArray(payload.tracks)
        ? payload.tracks.filter(isBgmTrack)
        : [];
    } catch {
      this.bgmTracks = [];
    }
    return this.bgmTracks;
  }

  /** BGM 文件缺失或浏览器不支持时静默降级,不抛错、不阻塞。 */
  async loadBgm(): Promise<void> {
    const tracks = await this.loadBgmPlaylist();
    if (tracks.length === 0) {
      this.bgm = null;
      this.bgmAvailable = false;
      return;
    }
    // 每次进入一局都随机选歌；“下一首”仍从这首歌的下一项开始循环。
    const start = Math.floor(Math.random() * tracks.length);
    await this.loadBgmFrom(start);
  }

  /** 手动切换到下一首；不支持或损坏的文件会自动跳过。 */
  async nextBgm(): Promise<BgmTrack | null> {
    const tracks = await this.loadBgmPlaylist();
    if (tracks.length === 0) return null;
    const start = this.currentBgmIndex >= 0 ? this.currentBgmIndex + 1 : 0;
    await this.loadBgmFrom(start);
    return this.getCurrentBgm();
  }

  private async loadBgmFrom(startIndex: number): Promise<void> {
    const tracks = this.bgmTracks ?? [];
    for (let offset = 0; offset < tracks.length; offset++) {
      const index = (startIndex + offset) % tracks.length;
      const track = tracks[index];
      try {
        const el = new Audio(track.url);
        el.loop = true;
        el.volume = BGM_BASE_VOLUME * this.volume;
        el.muted = this.bgmMuted;
        await new Promise<void>((resolve, reject) => {
          el.addEventListener('canplaythrough', () => resolve(), { once: true });
          el.addEventListener('error', () => reject(new Error('bgm missing')), { once: true });
          el.load();
        });
        this.bgm?.pause();
        this.bgm = el;
        this.bgmAvailable = true;
        this.currentBgmIndex = index;
        this.emitBgmTrackChange();
        // “下一首”可在战斗中直接替换当前曲目；若 BGM 已处于请求播放状态，立即续播新曲。
        if (this.bgmRequested && !this.bgmMuted) {
          void el.play().catch(() => { /* 浏览器要求下一次用户交互后再恢复 */ });
        }
        return;
      } catch {
        // 尝试列表中的下一首。
      }
    }
    this.bgm = null;
    this.bgmAvailable = false;
    this.currentBgmIndex = -1;
    this.emitBgmTrackChange();
  }

  startBgm(): void {
    this.bgmRequested = true;
    if (this.bgm) void this.bgm.play().catch(() => { /* 自动播放被拦截,忽略 */ });
  }

  stopBgm(): void {
    this.bgmRequested = false;
    if (this.bgm) { this.bgm.pause(); this.bgm.currentTime = 0; }
  }

  dispose(): void {
    this.stopBgm();
    void this.ctx?.close();
    this.ctx = null;
  }

  private emitBgmTrackChange(): void {
    const track = this.getCurrentBgm();
    for (const listener of this.bgmTrackListeners) listener(track);
  }
}

export const audio = new AudioEngine();

function readAudioPreference(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function writeAudioPreference(key: string, value: boolean | number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // 无痕模式或受限 WebView 不能写入时，仍保留当前页面内的开关状态。
  }
}

function readAudioVolume(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return 1;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
  } catch {
    return 1;
  }
}

function isBgmTrack(value: unknown): value is BgmTrack {
  if (!value || typeof value !== 'object') return false;
  const track = value as { name?: unknown; url?: unknown };
  return typeof track.name === 'string'
    && track.name.length > 0
    && typeof track.url === 'string'
    && track.url.startsWith('/assets/audio/');
}
