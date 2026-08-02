export interface PartyListProps {
  players: { playerId: string; nick: string; score: number; isSelf: boolean }[];
}

export function PartyList({ players }: PartyListProps) {
  const sorted = [...players].sort((a, b) => b.score - a.score);

  return (
    <div className="party-list">
      <ul className="party-list__players">
        {sorted.map((p) => (
          <li key={p.playerId} className={p.isSelf ? 'party-list__row party-list__row--self' : 'party-list__row'}>
            <span className="party-list__nick">{p.nick}</span>
            <span className="party-list__score">{p.score}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
