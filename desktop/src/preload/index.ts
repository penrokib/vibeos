// =============================================================================
// rokibrain.app — preload (M01)
// -----------------------------------------------------------------------------
// Bridges typed IPC into the renderer via contextBridge ONLY.
// Hard wall: nodeIntegration is permanently false in BrowserWindow webPreferences.
// =============================================================================

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AuthEnrollPayload,
  type OpenExternalPayload,
  type AuthStatusPayload,
  type CaptureScreenshotPayload,
  type CockpitClosePaneRequest,
  type CockpitInputRequest,
  type CockpitListPanesResponse,
  type CockpitOpenPaneRequest,
  type CockpitOpenPaneResponse,
  type CockpitOutputPayload,
  type DaemonChildRestartRequest,
  type DaemonEmergencyStopPayload,
  type DaemonStatusPayload,
  type DaemonWsPortPayload,
  type ListBugsInput,
  type ListBugsResult,
  type MeshAccountsPayload,
  type MeshChatsPayload,
  type MeshChatsRequest,
  type MeshMessagesPayload,
  type MeshMessagesRequest,
  type PauseTogglePayload,
  type PrsListPayload,
  type PrsMergeRequest,
  type PrsMergeResponse,
  type PrsOpenShellRequest,
  type RokibrainBridgeApi,
  type SecretKey,
  type SecretsGetPayload,
  type SecretsListPayload,
  type SecretsSetPayload,
  type SubmitBugInput,
  type SubmitBugResult,
  type SupervisorStatusPayload,
  type TabId,
  type TabSwitchPayload,
  type VoiceTogglePayload,
} from '../shared/ipc-contracts';

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const wrapped = (_evt: Electron.IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: RokibrainBridgeApi = {
  daemon: {
    onStatus: (handler) => subscribe<DaemonStatusPayload>(IPC.DAEMON_STATUS, handler),
    getWsPort: () => ipcRenderer.invoke(IPC.DAEMON_WS_PORT) as Promise<DaemonWsPortPayload>,
    getSupervisorStatus: () =>
      ipcRenderer.invoke(IPC.DAEMON_SUPERVISOR_STATUS) as Promise<SupervisorStatusPayload>,
    onSupervisorStatus: (handler) =>
      subscribe<SupervisorStatusPayload>(IPC.DAEMON_SUPERVISOR_BROADCAST, handler),
    restartChild: (req: DaemonChildRestartRequest) =>
      ipcRenderer.invoke(IPC.DAEMON_CHILD_RESTART, req) as Promise<void>,
    emergencyStop: (payload?: DaemonEmergencyStopPayload) =>
      ipcRenderer.invoke(IPC.DAEMON_EMERGENCY_STOP, payload) as Promise<void>,
  },
  tabs: {
    switch: (tab: TabId) => ipcRenderer.invoke(IPC.TABS_SWITCH, tab) as Promise<void>,
    onSwitch: (handler) => subscribe<TabSwitchPayload>(IPC.TABS_SWITCH, handler),
  },
  pause: {
    toggle: () => ipcRenderer.invoke(IPC.PAUSE_TOGGLE) as Promise<PauseTogglePayload>,
    onToggle: (handler) => subscribe<PauseTogglePayload>(IPC.PAUSE_TOGGLE, handler),
  },
  voice: {
    toggle: () => ipcRenderer.invoke(IPC.VOICE_TOGGLE) as Promise<VoiceTogglePayload>,
    onToggle: (handler) => subscribe<VoiceTogglePayload>(IPC.VOICE_TOGGLE, handler),
  },
  prs: {
    list: () => ipcRenderer.invoke(IPC.PRS_LIST) as Promise<PrsListPayload>,
    merge: (req: PrsMergeRequest) =>
      ipcRenderer.invoke(IPC.PRS_MERGE, req) as Promise<PrsMergeResponse>,
    openShell: (req: PrsOpenShellRequest) =>
      ipcRenderer.invoke(IPC.PRS_OPEN_SHELL, req) as Promise<void>,
  },
  secrets: {
    get: async (key: SecretKey) => {
      const result = (await ipcRenderer.invoke(IPC.SECRETS_GET, key)) as SecretsGetPayload;
      return result.value;
    },
    set: (key: SecretKey, value: string) =>
      ipcRenderer.invoke(IPC.SECRETS_SET, { key, value } satisfies SecretsSetPayload) as Promise<void>,
    delete: (key: SecretKey) => ipcRenderer.invoke(IPC.SECRETS_DELETE, key) as Promise<void>,
    list: async () => {
      const result = (await ipcRenderer.invoke(IPC.SECRETS_LIST)) as SecretsListPayload;
      return result.keys;
    },
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.AUTH_STATUS) as Promise<AuthStatusPayload>,
    enroll: (endpoint: string) =>
      ipcRenderer.invoke(IPC.AUTH_ENROLL, { endpoint } satisfies AuthEnrollPayload) as Promise<void>,
    logout: () => ipcRenderer.invoke(IPC.AUTH_LOGOUT) as Promise<void>,
    onStatusChange: (handler) => subscribe<AuthStatusPayload>(IPC.AUTH_STATUS_CHANGE, handler),
  },
  bugs: {
    capture: () => ipcRenderer.invoke(IPC.BUGS_CAPTURE) as Promise<CaptureScreenshotPayload>,
    submit: (input: SubmitBugInput) => ipcRenderer.invoke(IPC.BUGS_SUBMIT, input) as Promise<SubmitBugResult>,
    list: (input: ListBugsInput) => ipcRenderer.invoke(IPC.BUGS_LIST, input) as Promise<ListBugsResult>,
  },
  mesh: {
    accounts: () => ipcRenderer.invoke(IPC.MESH_ACCOUNTS) as Promise<MeshAccountsPayload>,
    chats: (req: MeshChatsRequest) =>
      ipcRenderer.invoke(IPC.MESH_CHATS, req) as Promise<MeshChatsPayload>,
    messages: (req: MeshMessagesRequest) =>
      ipcRenderer.invoke(IPC.MESH_MESSAGES, req) as Promise<MeshMessagesPayload>,
  },
  cockpit: {
    openPane: (req: CockpitOpenPaneRequest) =>
      ipcRenderer.invoke(IPC.COCKPIT_OPEN_PANE, req) as Promise<CockpitOpenPaneResponse>,
    input: (req: CockpitInputRequest) =>
      ipcRenderer.invoke(IPC.COCKPIT_INPUT, req) as Promise<void>,
    closePane: (req: CockpitClosePaneRequest) =>
      ipcRenderer.invoke(IPC.COCKPIT_CLOSE_PANE, req) as Promise<void>,
    listPanes: () =>
      ipcRenderer.invoke(IPC.COCKPIT_LIST_PANES) as Promise<CockpitListPanesResponse>,
    onOutput: (handler: (payload: CockpitOutputPayload) => void) =>
      subscribe<CockpitOutputPayload>(IPC.COCKPIT_OUTPUT, handler),
  },
  app: {
    quit: () => ipcRenderer.send(IPC.APP_QUIT),
    version: process.env.npm_package_version ?? '0.1.0',
    platform: process.platform,
    openExternal: (url: string) =>
      ipcRenderer.invoke(
        IPC.APP_OPEN_EXTERNAL,
        { url } satisfies OpenExternalPayload,
      ) as Promise<void>,
  },
};

contextBridge.exposeInMainWorld('rokibrain', api);
