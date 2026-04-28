/** Matrix m.room.history_visibility — set before inviting a new member */
export type MatrixHistoryVisibility = 'shared' | 'invited' | 'joined' | 'world_readable';

export const HISTORY_VISIBILITY_OPTIONS: Array<{
  value: MatrixHistoryVisibility;
  label: string;
  hint: string;
}> = [
  { value: 'shared', label: 'Tüm geçmiş', hint: 'Yeni üye odaya katılmadan önceki mesajları da görür.' },
  { value: 'invited', label: 'Davetten itibaren', hint: 'Yalnızca davet edildikten sonraki mesajlar.' },
  { value: 'joined', label: 'Katılımdan itibaren', hint: 'Yalnızca odaya katıldıktan sonraki mesajlar.' },
  { value: 'world_readable', label: 'Herkese açık geçmiş', hint: 'Matrix world_readable; özel sohbetlerde nadiren uygundur.' },
];
