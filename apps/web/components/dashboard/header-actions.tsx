'use client';

import React from 'react';

export function DashboardHeaderActions() {
  const handleOpenActions = () => {
    window.dispatchEvent(new Event('open-actions-modal'));
  };

  return (
    <button
      type="button"
      onClick={handleOpenActions}
      className="rounded-full border border-slate-200 bg-white/95 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100"
    >
      Manage connections & sync
    </button>
  );
}
