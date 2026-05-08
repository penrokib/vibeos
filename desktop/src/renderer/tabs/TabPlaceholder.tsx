// Generic tab placeholder. Wave-3 agents replace this with the real UI per row.
import type { JSX } from 'react';
import type { TabId } from '../../shared/ipc-contracts';

interface Props {
  tabId: TabId;
  label: string;
  module: string;
  description: string;
}

export function TabPlaceholder({ tabId, label, module, description }: Props): JSX.Element {
  return (
    <section className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
      <div className="rounded-full border border-neutral-800 px-3 py-1 text-[11px] uppercase tracking-wider text-neutral-500">
        {module} coming
      </div>
      <h1 className="text-2xl font-semibold text-neutral-100">{label}</h1>
      <p className="max-w-md text-sm text-neutral-400">{description}</p>
      <code className="mt-4 rounded bg-neutral-900 px-2 py-1 text-[11px] text-neutral-500">
        tab id: {tabId}
      </code>
    </section>
  );
}
