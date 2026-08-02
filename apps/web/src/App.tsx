import { useEffect, useState } from 'react';
import { MainMenu, type SoloStartConfig } from './scenes/MainMenu';
import { SoloBattle, type SoloResult } from './scenes/SoloBattle';
import { Results } from './scenes/Results';
import { CoopSession } from './scenes/CoopSession';
import { audio } from './engine/audio';

type Scene = 'menu' | 'solo' | 'results' | 'coop';

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

export default function App() {
  const [scene, setScene] = useState<Scene>('menu');
  const [soloConfig, setSoloConfig] = useState<SoloStartConfig | null>(null);
  const [soloResult, setSoloResult] = useState<SoloResult | null>(null);
  const [battleKey, setBattleKey] = useState(0);
  const [victoryCount, setVictoryCount] = useState(0);

  return (
    <div className="app">
      <div className="mobile-warning">建议使用桌面浏览器进行本游戏,移动端暂不适配。</div>
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
        />
      )}

      {scene === 'solo' && soloConfig && (
        <SoloBattle
          key={battleKey}
          pool={soloConfig.pool}
          mode={soloConfig.mode}
          difficulty={soloConfig.difficulty}
          onExit={() => setScene('menu')}
          onFinish={(result) => {
            setSoloResult(result);
            if (result.victory) setVictoryCount((count) => count + 1);
            setScene('results');
          }}
        />
      )}

      {scene === 'results' && soloResult && soloConfig && (
        <Results
          result={soloResult}
          onRetry={() => {
            setBattleKey((k) => k + 1);
            setScene('solo');
          }}
          onBackToMenu={() => setScene('menu')}
        />
      )}

      {scene === 'coop' && <CoopSession onExit={() => setScene('menu')} onVictory={() => setVictoryCount((count) => count + 1)} />}
    </div>
  );
}
