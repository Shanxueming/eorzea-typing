import { useState } from 'react';

export interface BattleExitControlProps {
  /** 联机离开会主动断开房间连接，因此需要额外提示队友会受到影响。 */
  isCoop?: boolean;
  onConfirm: () => void;
}

/** 战斗中返回菜单必须显式二次确认，避免玩家在高压输入时误触直接丢局。 */
export function BattleExitControl({ isCoop = false, onConfirm }: BattleExitControlProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <button className="battle__exit" type="button" onClick={() => setConfirming(true)}>
        返回主菜单
      </button>
      {confirming && (
        <div className="battle-exit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="battle-exit-title">
          <div className="battle-exit-dialog__panel">
            <h2 id="battle-exit-title">确定放弃本局？</h2>
            <p>{isCoop ? '返回后会离开房间，队友将继续本局。' : '本局进度不会结算，也不会计入通关记录。'}</p>
            <div className="battle-exit-dialog__actions">
              <button type="button" onClick={() => setConfirming(false)}>继续战斗</button>
              <button className="battle-exit-dialog__confirm" type="button" onClick={onConfirm}>确认返回</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
