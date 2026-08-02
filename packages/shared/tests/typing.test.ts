import { describe, it, expect } from 'vitest';
import { typingReducer, initialTypingState, type TypingState } from '../src/typingReducer';
import type { WordEntry } from '../src/types';

const 九天: WordEntry = {
  id: 'act_00412', text: '必杀剑·九天', typeText: '必杀剑九天',
  reading: 'bi sha jian jiu tian', category: 'actions', difficulty: 2, pure: false,
};

const run = (events: any[], start?: TypingState) =>
  events.reduce(typingReducer, start ?? initialTypingState(0));

describe('IME 合成态门控', () => {
  it('★ 合成期间输入拼音串不判错', () => {
    const s = run([
      { type: 'COMPOSITION_START' },
      { type: 'INPUT', value: 'bishajian', entry: 九天, mode: 'hanzi' },
    ]);
    expect(s.isComposing).toBe(true);
    expect(s.input).toBe('bishajian');
    // 关键:拼音串明显不匹配「必杀剑九天」,但状态必须仍是 empty,不能变 error
    expect(s.status).toBe('empty');
  });

  it('合成结束后才判定,上屏汉字算进行中', () => {
    const s = run([
      { type: 'COMPOSITION_START' },
      { type: 'INPUT', value: 'bishajian', entry: 九天, mode: 'hanzi' },
      { type: 'COMPOSITION_END', value: '必杀剑', entry: 九天, mode: 'hanzi' },
    ]);
    expect(s.isComposing).toBe(false);
    expect(s.status).toBe('progress');
    expect(s.matchedLength).toBe(3);
    expect(s.compositionCommits).toBe(1);
  });

  it('完整打完一个词判定为 complete', () => {
    const s = run([
      { type: 'COMPOSITION_START' },
      { type: 'COMPOSITION_END', value: '必杀剑', entry: 九天, mode: 'hanzi' },
      { type: 'COMPOSITION_START' },
      { type: 'COMPOSITION_END', value: '必杀剑九天', entry: 九天, mode: 'hanzi' },
    ]);
    expect(s.status).toBe('complete');
    expect(s.compositionCommits).toBe(2);
  });

  it('非合成态下的直接输入正常判定(英文/拼音模式)', () => {
    const s = run([{ type: 'INPUT', value: 'bisha', entry: 九天, mode: 'pinyin' }]);
    expect(s.status).toBe('progress');
  });

  it('上屏后打错能判为 error', () => {
    const s = run([
      { type: 'COMPOSITION_START' },
      { type: 'COMPOSITION_END', value: '必杀刀', entry: 九天, mode: 'hanzi' },
    ]);
    expect(s.status).toBe('error');
    expect(s.matchedLength).toBe(2);
  });
});

describe('击键遥测采集', () => {
  it('★ 合成态下的物理按键照样记录', () => {
    const s = run([
      { type: 'COMPOSITION_START' },
      { type: 'KEYDOWN', code: 'KeyB', trusted: true, composing: true, now: 100 },
      { type: 'KEYDOWN', code: 'KeyI', trusted: true, composing: true, now: 190 },
    ]);
    expect(s.keystrokes).toHaveLength(2);
    expect(s.keystrokes[0].composing).toBe(true);
    expect(s.keystrokes[1].t).toBe(190);
  });

  it('退格被单独计数', () => {
    const s = run([
      { type: 'KEYDOWN', code: 'KeyA', trusted: true, composing: false, now: 10 },
      { type: 'KEYDOWN', code: 'Backspace', trusted: true, composing: false, now: 60 },
      { type: 'KEYDOWN', code: 'Backspace', trusted: true, composing: false, now: 120 },
    ]);
    expect(s.backspaces).toBe(2);
    expect(s.keystrokes).toHaveLength(3);
  });

  it('非可信事件被如实记录,交给服务端拦截', () => {
    const s = run([
      { type: 'KEYDOWN', code: 'KeyA', trusted: false, composing: false, now: 10 },
    ]);
    expect(s.keystrokes[0].trusted).toBe(false);
  });
});

describe('失焦时长统计', () => {
  it('累计 blur 到 focus 之间的时长', () => {
    const s = run([
      { type: 'BLUR', now: 1000 },
      { type: 'FOCUS', now: 3500 },
      { type: 'BLUR', now: 5000 },
      { type: 'FOCUS', now: 5500 },
    ]);
    expect(s.focusLostMs).toBe(3000);
    expect(s.blurredAt).toBeNull();
  });

  it('重复 BLUR 不重复计时', () => {
    const s = run([
      { type: 'BLUR', now: 1000 },
      { type: 'BLUR', now: 2000 },
      { type: 'FOCUS', now: 3000 },
    ]);
    expect(s.focusLostMs).toBe(2000);
  });
});

describe('换词重置', () => {
  it('RESET 清空全部状态并记录新的起始时刻', () => {
    const s = run([
      { type: 'KEYDOWN', code: 'KeyA', trusted: true, composing: false, now: 10 },
      { type: 'COMPOSITION_START' },
      { type: 'RESET', now: 9000 },
    ]);
    expect(s.keystrokes).toHaveLength(0);
    expect(s.isComposing).toBe(false);
    expect(s.status).toBe('empty');
    expect(s.wordStartedAt).toBe(9000);
  });
});
