import { useState, useCallback } from 'react';
import type { Role } from '../lib/constants';

const STORAGE_KEY = 'wealth-app-role';

export function useRole() {
  const [role, setRoleState] = useState<Role | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'advisor' || saved === 'admin' || saved === 'audit' || saved === 'customer') return saved;
    return null;
  });

  const setRole = useCallback((r: Role) => {
    localStorage.setItem(STORAGE_KEY, r);
    setRoleState(r);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setRoleState(null);
  }, []);

  return { role, setRole, logout };
}
