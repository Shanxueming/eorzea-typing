import { useEffect, useState } from 'react';
import { MainMenu, type SoloStartConfig } from './scenes/MainMenu';
import { SoloBattle, type SoloResult } from './scenes/SoloBattle';
import { Results } from './scenes/Results';
import { CoopSession } from './scenes/CoopSession';
import { AccountScene } from './scenes/AccountScene';
import { AdminScene } from './scenes/AdminScene';
import { loadSession, type Session } from './engine/accountApi';
import { audio } from './engine/audio';
import { ChangelogModal } from './components/ChangelogModal';
import { hasSeenLatest } from './data/changelog';

type Scene = 'menu' | 'solo' | 'results' | 'coop' | 'account' | 'admin';

/** 音乐与音效分开控制，偏好由 AudioEngine 存在浏览器本地。 */
function AudioControls() {
  const [bgmMuted, setBgmMuted] = useState(() => audio.isBgmMuted());
  const [sfxMuted, setSfxMuted] = useState(() => audio.isSfxMuted());
  const [volume, setVolume] = useState(() => audio.getVolume());
  const [trackName, setTrackName] = useState(() => audio.getCurrentBgm()?.name ?? null);
  const [hasTracks, setHasTracks] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    const unsubscribe = audio.onBgmTrackChange((track) => setTrackName(track?.name ?? null));
    void audio.loadBgmPlaylist().then((tracks) => setHasTracks(tracks.length > 0));
    return unsubscribe;
  }, []);

  async function nextTrack() {
    audio.unlock();
    setSwitching(true);
    try {
      await audio.nextBgm();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="app__audio-controls" aria-label="声音设置">
      <button
        type="button"
        aria-pressed={!bgmMuted}
        onClick={() => {
          const next = !bgmMuted;
          audio.setBgmMuted(next);
          setBgmMuted(next);
        }}
      >
        {bgmMuted ? '🎵 BGM 关' : '🎵 BGM 开'}
      </button>
      <div className="app__now-playing" title={trackName ?? undefined}>
        {trackName ? `BGM：${trackName}` : hasTracks ? 'BGM：等待战斗开始' : 'BGM：未检测到音频'}
      </div>
      <button type="button" disabled={!hasTracks || switching} onClick={() => void nextTrack()}>
        {switching ? '切换中…' : '下一首'}
      </button>
      <label className="app__volume-control">
        音量 {Math.round(volume * 100)}%
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          onChange={(event) => {
            const next = Number(event.target.value);
            audio.setVolume(next);
            setVolume(next);
          }}
        />
      </label>
      <button
        type="button"
        aria-pressed={!sfxMuted}
        onClick={() => {
          const next = !sfxMuted;
          audio.setSfxMuted(next);
          setSfxMuted(next);
        }}
      >
        {sfxMuted ? '🔇 音效关' : '🔊 音效开'}
      </button>
    </div>
  );
}

/**
 * 移动端只做单人:联机要两个人对着房间码互相等,小屏上体验差,而且触屏 IME 的
 * 时序差异更容易踩到反作弊的硬校验。用媒体查询而不是 UA 嗅探判断,横屏平板
 * 一样能玩联机。
 */
const MOBILE_QUERY = '(max-width: 720px), (pointer: coarse) and (max-width: 1024px)';

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    // ★ 挂 listener 之前必须先同步一次当前值。首次渲染求值到这个 effect 执行
    //   之间视口可能已经变了(页面在视口尺寸还是 0 的时候完成首屏渲染就会这样),
    //   那一次 change 事件发生在我们订阅之前,永远收不到 —— 结果就是桌面浏览器
    //   被永久判定成移动端、联机入口再也不出现。
    setIsMobile(mq.matches);
    const onChange = (ev: MediaQueryListEvent) => setIsMobile(ev.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

export default function App() {
  const [scene, setScene] = useState<Scene>('menu');
  const [soloConfig, setSoloConfig] = useState<SoloStartConfig | null>(null);
  const [soloResult, setSoloResult] = useState<SoloResult | null>(null);
  const [battleKey, setBattleKey] = useState(0);
  const [victoryCount, setVictoryCount] = useState(0);
  const isMobile = useIsMobile();
  // 有新版更新说明就自动弹一次;看过之后只能从主菜单再点开
  const [showChangelog, setShowChangelog] = useState(() => !hasSeenLatest());
  const [session, setSession] = useState<Session | null>(() => loadSession());

  /**
   * 管理后台只能靠手敲 #admin 进,菜单里不给入口 ——
   * 玩家永远用不到它,摆在那儿只会让人好奇去点。
   * 监听 hashchange 是为了让「地址栏改一下就进」这条路真的能走通。
   */
  useEffect(() => {
    const sync = () => {
      if (window.location.hash === '#admin') setScene('admin');
      else if (scene === 'admin') setScene('menu');
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 从联机场景切到窄屏(转竖屏、缩窗口)时把人送回菜单,免得卡在一个
  // 移动端不再支持的场景里。
  useEffect(() => {
    if (isMobile && scene === 'coop') setScene('menu');
  }, [isMobile, scene]);

  return (
    // 主菜单与账号页是多栏布局,720px 的默认宽度装不下;战斗页保持窄栏
    // —— 打字的时候视线不该左右横跳。
    <div className={`app${isMobile ? ' app--mobile' : ''}${
      scene === 'menu' || scene === 'account' ? ' app--wide' : ''}`}>
      <AudioControls />

      {scene === 'menu' && (
        <MainMenu
          onStartSolo={(config) => {
            setSoloConfig(config);
            setBattleKey((k) => k + 1);
            setScene('solo');
          }}
          onGoCoop={() => setScene('coop')}
          victoryCount={victoryCount}
          coopAvailable={!isMobile}
          onShowChangelog={() => setShowChangelog(true)}
          onGoAccount={() => setScene('account')}
          session={session}
        />
      )}

      {scene === 'solo' && soloConfig && (
        <SoloBattle
          key={battleKey}
          pool={soloConfig.pool}
          mode={soloConfig.mode}
          difficulty={soloConfig.difficulty}
          inputMode={soloConfig.inputMode}
          character={soloConfig.character}
          gameMode={soloConfig.gameMode}
          categories={soloConfig.categories}
          pureOnly={soloConfig.pureOnly}
          onExit={() => setScene('menu')}
          onFinish={(result) => {
            setSoloResult(result);
            if (result.victory) setVictoryCount((count) => count + 1);
            setScene('results');
          }}
        />
      )}

      {scene === 'admin' && (
        <AdminScene onExit={() => { window.location.hash = ''; setScene('menu'); }} />
      )}

      {scene === 'account' && (
        <AccountScene
          session={session}
          onSession={setSession}
          onExit={() => setScene('menu')}
        />
      )}

      {scene === 'results' && soloResult && soloConfig && (
        <Results
          result={soloResult}
          session={session}
          onGoAccount={() => setScene('account')}
          onRetry={() => {
            setBattleKey((k) => k + 1);
            setScene('solo');
          }}
          onBackToMenu={() => setScene('menu')}
        />
      )}

      {scene === 'coop' && <CoopSession onExit={() => setScene('menu')} onVictory={() => setVictoryCount((count) => count + 1)} />}

      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
    </div>
  );
}
