// =============================================================================
// rokibrain.app — Cockpit Tab (M06a renderer scaffold)
// -----------------------------------------------------------------------------
// xterm.js terminal view backed by the IPC cockpit envelope contract.
// v1 ships an echo placeholder; cycle 9 wires the real bridge-mac PTY child.
//
// Hard walls:
//   - Renderer accesses cockpit ONLY via window.rokibrain.cockpit.*
//   - DO NOT spawn subprocesses here — that is main-process territory (cycle 9)
//   - Keystroke hardwall lives in bridge-mac child (cycle 9); v1 echoes harmlessly
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import type { CockpitPane } from '../../shared/ipc-contracts';

export function CockpitTab(): JSX.Element {
  const [panes, setPanes] = useState<CockpitPane[]>([]);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [panesError, setPanesError] = useState<string | null>(null);

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activePaneIdRef = useRef<string | null>(null);

  // Keep ref in sync for use inside callbacks without stale closure.
  useEffect(() => {
    activePaneIdRef.current = activePaneId;
  }, [activePaneId]);

  // Load pane list on mount.
  useEffect(() => {
    void (async () => {
      try {
        const { panes: list } = await window.rokibrain.cockpit.listPanes();
        setPanes(list);
        setPanesError(null);
        if (list.length > 0 && list[0]) {
          setActivePaneId(list[0].id);
        }
      } catch (err) {
        setPanesError(err instanceof Error ? err.message : 'Failed to list cockpit panes');
      }
    })();
  }, []);

  // Subscribe to cockpit output from main.
  useEffect(() => {
    const off = window.rokibrain.cockpit.onOutput(({ paneId, data }) => {
      if (paneId === activePaneIdRef.current && xtermRef.current) {
        xtermRef.current.write(data);
      }
    });
    return off;
  }, []);

  // Mount / remount xterm when activePaneId changes.
  useEffect(() => {
    if (!activePaneId || !termRef.current) return;

    // Clean up previous terminal instance.
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    if (fitAddonRef.current) {
      fitAddonRef.current = null;
    }

    const term = new Terminal({
      theme: {
        background: '#0b0b0d',
        foreground: '#d4d4d4',
        cursor: '#6ee7b7',
      },
      fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Inform main of the pane dimensions.
    void window.rokibrain.cockpit.openPane({
      paneId: activePaneId,
      cols: term.cols,
      rows: term.rows,
    });

    term.writeln('\x1b[32mrokibrain cockpit — echo placeholder (bridge-mac wiring in cycle 9)\x1b[0m');
    term.writeln('Type anything and press Enter — main will echo it back.');
    term.writeln('');

    // Forward keystrokes to main.
    term.onData((data) => {
      const paneId = activePaneIdRef.current;
      if (!paneId) return;
      void window.rokibrain.cockpit.input({ paneId, data });
    });

    // Refit on window resize.
    const handleResize = (): void => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [activePaneId]);

  const handleSelectPane = useCallback((id: string) => {
    setActivePaneId(id);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-white">Cockpit (terminal mirror)</h1>
          <p className="text-xs text-neutral-500">
            xterm.js scaffold · echo placeholder · bridge-mac PTY wires in cycle 9
          </p>
        </div>
        <button
          type="button"
          disabled
          title="available after cycle 9"
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-500 cursor-not-allowed opacity-50"
        >
          + New pane
        </button>
      </header>

      {panesError ? (
        <div className="border-b border-red-900/50 bg-red-950/20 px-6 py-2 text-xs text-red-300">
          cockpit error: {panesError}
        </div>
      ) : null}

      <div className="flex flex-1 overflow-hidden">
        {/* Left rail: pane list */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/40">
          <div className="px-3 pt-3 text-[10px] uppercase tracking-wider text-neutral-500">
            Panes
          </div>
          <ul className="mt-2 flex-1 space-y-0.5 px-2">
            {panes.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-neutral-500">
                No panes yet — bridge-mac wiring ships in cycle 9
              </li>
            ) : (
              panes.map((pane) => {
                const isActive = pane.id === activePaneId;
                return (
                  <li key={pane.id}>
                    <button
                      type="button"
                      onClick={() => handleSelectPane(pane.id)}
                      className={
                        'flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors ' +
                        (isActive
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'text-neutral-300 hover:bg-neutral-800/70 hover:text-white')
                      }
                    >
                      <span className="truncate">{pane.label}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </aside>

        {/* Terminal area */}
        <section className="flex flex-1 flex-col overflow-hidden">
          {activePaneId ? (
            <div
              ref={termRef}
              data-testid="cockpit-terminal"
              className="flex-1 overflow-hidden p-2"
              style={{ backgroundColor: '#0b0b0d' }}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-neutral-500">
              No panes yet — bridge-mac wiring ships in cycle 9
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
