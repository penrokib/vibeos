// =============================================================================
// rokibrain.app — Mesh Tab (M04 visible-slice)
// -----------------------------------------------------------------------------
// Three-pane read-only inbox over the local multi-account mesh backend
// (today: wa-multi-server on :8086 — wap/was/wab). Wave-3 plugs Telegram /
// Email / LinkedIn children behind the same shape via the M02 daemon.
//
// Hard walls:
//   - Drafts-only: NO send button. Sending stays in the Drafts tab approval
//     loop, gated by anti-ban + persona-author.
//   - All API calls go through main via IPC (renderer cannot fetch the mesh
//     backend directly — preserves the contextIsolation contract).
// =============================================================================

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type {
  MeshAccount,
  MeshChat,
  MeshMessage,
} from '../../shared/ipc-contracts';

const ACCOUNTS_REFRESH_MS = 15_000;
const MESSAGES_REFRESH_MS = 10_000;

export function MeshTab(): JSX.Element {
  const [accounts, setAccounts] = useState<MeshAccount[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [activeAccount, setActiveAccount] = useState<string | null>(null);

  const [chats, setChats] = useState<MeshChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [activeChatJid, setActiveChatJid] = useState<string | null>(null);

  const [messages, setMessages] = useState<MeshMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const { accounts: list } = await window.rokibrain.mesh.accounts();
      setAccounts(list);
      setAccountsError(null);
      setActiveAccount((prev) => {
        if (prev && list.some((a) => a.account === prev)) return prev;
        return list[0]?.account ?? null;
      });
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : 'Failed to reach mesh backend');
    }
  }, []);

  const loadChats = useCallback(async (account: string) => {
    setChatsLoading(true);
    setChatsError(null);
    try {
      const { chats: list } = await window.rokibrain.mesh.chats({ account, limit: 100 });
      setChats(list);
    } catch (err) {
      setChats([]);
      setChatsError(err instanceof Error ? err.message : 'Failed to load chats');
    } finally {
      setChatsLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (account: string, chatJid: string) => {
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const { messages: list } = await window.rokibrain.mesh.messages({
        account,
        chatJid,
        limit: 100,
      });
      setMessages(list);
    } catch (err) {
      setMessages([]);
      setMessagesError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  // Initial + periodic accounts refresh.
  useEffect(() => {
    void loadAccounts();
    const id = window.setInterval(() => {
      void loadAccounts();
    }, ACCOUNTS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadAccounts]);

  // Reload chats when the active account changes.
  useEffect(() => {
    if (!activeAccount) {
      setChats([]);
      setActiveChatJid(null);
      return;
    }
    void loadChats(activeAccount);
    setActiveChatJid(null);
  }, [activeAccount, loadChats]);

  // Reload messages when the active chat changes + poll while open.
  useEffect(() => {
    if (!activeAccount || !activeChatJid) {
      setMessages([]);
      return;
    }
    void loadMessages(activeAccount, activeChatJid);
    const id = window.setInterval(() => {
      void loadMessages(activeAccount, activeChatJid);
    }, MESSAGES_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [activeAccount, activeChatJid, loadMessages]);

  const handleRefresh = useCallback(() => {
    void loadAccounts();
    if (activeAccount) void loadChats(activeAccount);
    if (activeAccount && activeChatJid) void loadMessages(activeAccount, activeChatJid);
  }, [activeAccount, activeChatJid, loadAccounts, loadChats, loadMessages]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-white">Mesh</h1>
          <p className="text-xs text-neutral-500">
            Read-only inbox · {accounts.length} account{accounts.length === 1 ? '' : 's'} · drafts-only sending
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
        >
          Refresh
        </button>
      </header>

      {accountsError ? (
        <div className="border-b border-red-900/50 bg-red-950/20 px-6 py-2 text-xs text-red-300">
          mesh backend unreachable: {accountsError}
        </div>
      ) : null}

      <div className="flex flex-1 overflow-hidden">
        {/* Account rail */}
        <aside className="flex w-44 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/40">
          <div className="px-3 pt-3 text-[10px] uppercase tracking-wider text-neutral-500">
            Accounts
          </div>
          <ul className="mt-2 flex-1 space-y-0.5 px-2">
            {accounts.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-neutral-500">no accounts</li>
            ) : (
              accounts.map((acct) => {
                const isActive = acct.account === activeAccount;
                return (
                  <li key={acct.account}>
                    <button
                      type="button"
                      onClick={() => setActiveAccount(acct.account)}
                      className={
                        'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors ' +
                        (isActive
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'text-neutral-300 hover:bg-neutral-800/70 hover:text-white')
                      }
                    >
                      <span className="truncate">{acct.account}</span>
                      <StatusDot status={acct.status} />
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </aside>

        {/* Chat list */}
        <section className="flex w-80 shrink-0 flex-col border-r border-neutral-800">
          <div className="border-b border-neutral-800 px-4 py-2 text-[10px] uppercase tracking-wider text-neutral-500">
            Chats {activeAccount ? `· ${activeAccount}` : ''}
          </div>
          <div className="flex-1 overflow-auto">
            {!activeAccount ? (
              <EmptyHint text="Pick an account" />
            ) : chatsLoading && chats.length === 0 ? (
              <EmptyHint text="Loading chats…" />
            ) : chatsError ? (
              <EmptyHint text={chatsError} tone="error" />
            ) : chats.length === 0 ? (
              <EmptyHint text="No chats" />
            ) : (
              <ul className="divide-y divide-neutral-900">
                {chats.map((chat) => {
                  const isActive = chat.jid === activeChatJid;
                  return (
                    <li key={chat.jid}>
                      <button
                        type="button"
                        onClick={() => setActiveChatJid(chat.jid)}
                        className={
                          'flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors ' +
                          (isActive
                            ? 'bg-emerald-500/10 text-emerald-200'
                            : 'text-neutral-200 hover:bg-neutral-900')
                        }
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {chat.name || chat.jid}
                          </span>
                          <span className="shrink-0 text-[10px] text-neutral-500">
                            {formatRelative(chat.last_message_time)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs text-neutral-500">
                            {chat.last_message || '—'}
                          </span>
                          {chat.unread_count > 0 ? (
                            <span className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 text-[10px] font-medium text-emerald-300">
                              {chat.unread_count}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* Message thread */}
        <section className="flex flex-1 flex-col">
          <div className="border-b border-neutral-800 px-4 py-2 text-[10px] uppercase tracking-wider text-neutral-500">
            Thread {activeChatJid ? `· ${activeChatJid}` : ''}
          </div>
          <div className="flex-1 overflow-auto px-4 py-3">
            {!activeChatJid ? (
              <EmptyHint text="Pick a chat" />
            ) : messagesLoading && messages.length === 0 ? (
              <EmptyHint text="Loading messages…" />
            ) : messagesError ? (
              <EmptyHint text={messagesError} tone="error" />
            ) : messages.length === 0 ? (
              <EmptyHint text="No messages" />
            ) : (
              <ol className="space-y-2">
                {messages.map((msg) => (
                  <li
                    key={msg.id}
                    className={
                      'max-w-[80%] rounded-md px-3 py-2 text-sm ' +
                      (msg.is_from_me
                        ? 'ml-auto bg-emerald-500/15 text-emerald-100'
                        : 'mr-auto bg-neutral-900 text-neutral-200')
                    }
                  >
                    <div className="whitespace-pre-wrap break-words">
                      {msg.content || (msg.media_type ? `[${msg.media_type}]` : '—')}
                    </div>
                    <div className="mt-1 text-[10px] text-neutral-500">
                      {formatTimestamp(msg.timestamp)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <footer className="border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-500">
            sending is drafts-only · open the Drafts tab to approve outbound messages
          </footer>
        </section>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: MeshAccount['status'] }): JSX.Element {
  const tone =
    status === 'open'
      ? 'bg-emerald-400'
      : status === 'connecting'
        ? 'bg-amber-400'
        : status === 'close'
          ? 'bg-red-500'
          : 'bg-neutral-600';
  return <span className={`h-2 w-2 rounded-full ${tone}`} aria-label={status} />;
}

function EmptyHint({
  text,
  tone = 'muted',
}: {
  text: string;
  tone?: 'muted' | 'error';
}): JSX.Element {
  const cls = tone === 'error' ? 'text-red-400' : 'text-neutral-500';
  return (
    <div className={`flex h-full items-center justify-center px-4 py-6 text-xs ${cls}`}>
      {text}
    </div>
  );
}

function formatTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString();
}

function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return '';
  const diffSec = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
