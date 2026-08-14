declare namespace chrome {
  namespace alarms {
    interface Alarm { name: string; scheduledTime: number; }
    const onAlarm: Event<(alarm: Alarm) => void>;
    function create(name: string, alarmInfo: { when: number }): Promise<void>;
    function clear(name: string): Promise<boolean>;
  }
  namespace runtime {
    const lastError: { message?: string } | undefined;
    const onInstalled: Event<() => void>;
    const onStartup: Event<() => void>;
  }
  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    const onChanged: Event<(changes: Record<string, StorageChange>, areaName: string) => void>;
    namespace local {
      function get(keys: Record<string, unknown>, callback: (items: Record<string, unknown>) => void): void;
      function set(items: Record<string, unknown>, callback?: () => void): void;
    }
    namespace session {
      function get(keys: Record<string, unknown>, callback: (items: Record<string, unknown>) => void): void;
      function set(items: Record<string, unknown>, callback?: () => void): void;
    }
  }
  namespace action {
    function setBadgeText(details: { text: string }): void;
    function setBadgeBackgroundColor(details: { color: string }): void;
    function setTitle(details: { title: string }): void;
  }
  namespace windows {
    const WINDOW_ID_NONE: number;
    type WindowType = "normal" | "popup" | "panel" | "app" | "devtools";
    interface Window { id?: number; focused: boolean; incognito: boolean; type?: WindowType; }
    const onCreated: Event<(window: Window) => void>;
    const onFocusChanged: Event<(windowId: number) => void>;
    const onRemoved: Event<(windowId: number) => void>;
    function get(windowId: number, callback: (window: Window) => void): void;
    function getAll(getInfo: { windowTypes?: WindowType[] }, callback: (windows: Window[]) => void): void;
    function update(windowId: number, updateInfo: { focused?: boolean }, callback?: (window: Window) => void): void;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      openerTabId?: number;
      index: number;
      active: boolean;
      url?: string;
      pendingUrl?: string;
      pinned?: boolean;
      groupId?: number;
      splitViewId?: number;
    }
    const onActivated: Event<(activeInfo: { tabId: number; windowId: number }) => void>;
    const onCreated: Event<(tab: Tab) => void>;
    const onRemoved: Event<(tabId: number) => void>;
    const onUpdated: Event<(
      tabId: number,
      changeInfo: { url?: string },
      tab: Tab,
    ) => void>;
    function query(queryInfo: { windowId?: number; active?: boolean }, callback: (tabs: Tab[]) => void): void;
    function get(tabId: number, callback: (tab: Tab) => void): void;
    function group(groupOptions: { tabIds: number | number[]; groupId?: number }, callback?: (groupId: number) => void): void;
    function move(tabIds: number | number[], moveProperties: { windowId: number; index: number }, callback?: (tabs: Tab | Tab[]) => void): void;
    function update(tabId: number, updateProperties: { active?: boolean }, callback?: (tab: Tab) => void): void;
  }
  interface Event<T extends (...args: never[]) => void> { addListener(callback: T): void; }
}
