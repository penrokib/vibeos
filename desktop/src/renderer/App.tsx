// =============================================================================
// rokibrain.app — renderer App (M01)
// -----------------------------------------------------------------------------
// Tab shell with 11 placeholder tabs (per design §5 + capability list).
// Wave-3 agents (M06–M12) replace each placeholder body with the real UI.
// IPC consumed exclusively through `window.rokibrain` (typed via contextBridge).
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TAB_IDS,
  type DaemonStatusPayload,
  type PauseTogglePayload,
  type TabId,
  type VoiceTogglePayload,
} from '../shared/ipc-contracts';
import { PrsTab } from './prs/PrsTab';
import { Settings } from './settings/Settings';
import { BugsTab } from './bugs/BugsTab';
import { TabPlaceholder } from './tabs/TabPlaceholder';
import { KnowledgeTab } from './knowledge/KnowledgeTab';
import { PersonasTab } from './personas/PersonasTab';
import { DraftsTab } from './drafts/DraftsTab';
import { DecisionsTab } from './decisions/DecisionsTab';
import { MeshTab } from './mesh/MeshTab';
import { ConnectionsTab } from './connections/ConnectionsTab';

interface TabMeta {
  id: TabId;
  label: string;
  hotkey: string;
  module: string;
  description: string;
}

const TAB_META: readonly TabMeta[] = [
  { id: 'cockpit', label: 'Cockpit', hotkey: '⌘1', module: 'M06', description: 'Terminal mirror — tmux panes via apps/bridge-mac.' },
  { id: 'mesh', label: 'Mesh', hotkey: '⌘2', module: 'M04+M05', description: 'Inbox across WhatsApp / Telegram / Discord / Email / LinkedIn.' },
  { id: 'drafts', label: 'Drafts', hotkey: '⌘3', module: 'M07', description: 'Persona-authored drafts pending approval.' },
  { id: 'decisions', label: 'Decisions', hotkey: '⌘4', module: 'M07', description: 'Decisions queue from BFF.' },
  { id: 'knowledge', label: 'Knowledge', hotkey: '⌘5', module: 'M08', description: 'Search across knowledge bases.' },
  { id: 'personas', label: 'Personas', hotkey: '⌘6', module: 'M08', description: 'Persona browser + outbox.' },
  { id: 'prs', label: 'PRs', hotkey: '⌘7', module: 'M09', description: 'GitHub PR queue via gh subprocess.' },
  { id: 'bugs', label: 'Bugs', hotkey: '⌘8', module: 'M10', description: 'Bug reporter (absorbs apps/extension).' },
  { id: 'voice', label: 'Voice', hotkey: '⌘9', module: 'M11', description: 'whisper.cpp transcription + push-to-talk history.' },
  { id: 'connections', label: 'Connections', hotkey: '⌘0', module: 'M12', description: 'Mesh accounts + integration health.' },
  { id: 'settings', label: 'Settings', hotkey: '—', module: 'M12', description: 'Secrets, keychain, BFF token, autoupdate.' },
] as const;

export function App(): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('cockpit');
  const [paused, setPaused] = useState(false);
  const [voice, setVoice] = useState(false);
  const [daemon, setDaemon] = useState<DaemonStatusPayload>({
    status: 'starting',
    changedAt: new Date().toISOString(),
  });

  // Subscribe to all bridge events on mount.
  useEffect(() => {
    const offSwitch = window.rokibrain.tabs.onSwitch(({ tab }) => setActiveTab(tab));
    const offPause = window.rokibrain.pause.onToggle((p: PauseTogglePayload) => setPaused(p.paused));
    const offVoice = window.rokibrain.voice.onToggle((v: VoiceTogglePayload) => setVoice(v.listening));
    const offStatus = window.rokibrain.daemon.onStatus((s) => setDaemon(s));
    return () => {
      offSwitch();
      offPause();
      offVoice();
      offStatus();
    };
  }, []);

  const handleTabClick = useCallback((tab: TabId) => {
    setActiveTab(tab);
    void window.rokibrain.tabs.switch(tab);
  }, []);

  const activeMeta = useMemo(
    () => TAB_META.find((t) => t.id === activeTab) ?? TAB_META[0],
    [activeTab],
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Sidebar */}
      <nav className="flex w-56 flex-col border-r border-neutral-800 bg-neutral-900/60 backdrop-blur">
        <header className="px-4 pt-6 pb-4">
          <div className="text-sm font-semibold tracking-wide text-emerald-400">rokibrain</div>
          <div className="text-[10px] text-neutral-500">v{window.rokibrain.app.version} · {window.rokibrain.app.platform}</div>
        </header>
        <ul className="flex-1 space-y-1 px-2">
          {TAB_META.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => handleTabClick(tab.id)}
                  className={
                    'flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-sm transition-colors ' +
                    (isActive
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'text-neutral-300 hover:bg-neutral-800/70 hover:text-white')
                  }
                >
                  <span>{tab.label}</span>
                  <span className="text-[10px] text-neutral-500">{tab.hotkey}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <footer className="border-t border-neutral-800 px-4 py-3 text-[11px] text-neutral-500">
          <div className="flex items-center justify-between">
            <span>daemon</span>
            <DaemonDot status={daemon.status} />
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span>pause</span>
            <span className={paused ? 'text-amber-400' : 'text-neutral-600'}>{paused ? 'on' : 'off'}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span>voice</span>
            <span className={voice ? 'text-sky-400' : 'text-neutral-600'}>{voice ? 'listening' : 'off'}</span>
          </div>
        </footer>
      </nav>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        {activeTab === 'mesh' ? (
          <MeshTab />
        ) : activeTab === 'knowledge' ? (
          <KnowledgeTab />
        ) : activeTab === 'personas' ? (
          <PersonasTab />
        ) : activeTab === 'prs' ? (
          <PrsTab />
        ) : activeTab === 'settings' ? (
          <Settings />
        ) : activeTab === 'bugs' ? (
          <BugsTab />
        ) : activeTab === 'drafts' ? (
          <DraftsTab />
        ) : activeTab === 'decisions' ? (
          <DecisionsTab />
        ) : activeTab === 'connections' ? (
          <ConnectionsTab />
        ) : (
          <TabPlaceholder
            tabId={activeMeta.id}
            label={activeMeta.label}
            module={activeMeta.module}
            description={activeMeta.description}
          />
        )}
      </main>
    </div>
  );
}

function DaemonDot({ status }: { status: DaemonStatusPayload['status'] }): JSX.Element {
  const colour =
    status === 'ready'
      ? 'bg-emerald-400'
      : status === 'degraded'
        ? 'bg-amber-400'
        : status === 'crashed'
          ? 'bg-red-500'
          : 'bg-neutral-500';
  return <span className={`inline-block h-2 w-2 rounded-full ${colour}`} title={status} />;
}

// Compile-time guarantee that App handles every TabId (helps wave-3 agents).
const _exhaustivity: readonly TabId[] = TAB_IDS;
void _exhaustivity;
