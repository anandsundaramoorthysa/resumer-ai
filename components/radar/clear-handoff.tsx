'use client';

import { useEffect } from 'react';

/** Drops a stale Job Radar handoff so a first-run user never sees an old job pre-filled. */
export function ClearRadarHandoff() {
  useEffect(() => {
    try {
      sessionStorage.removeItem('radar:jobText');
      sessionStorage.removeItem('radar:jobLabel');
    } catch {
      /* storage blocked: nothing to clear */
    }
  }, []);
  return null;
}
