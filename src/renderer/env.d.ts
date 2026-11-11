/// <reference types="vite/client" />
interface Window {
  launcher: {
    getUpdateStatus(): Promise<any>;
    checkForUpdates(): Promise<any>;
    openUpdateRelease(url?: string): Promise<boolean>;
    downloadUpdate(): Promise<any>;
    installUpdate(): Promise<boolean>;
    getSettings(): Promise<any>;
    detectGameDirectory(): Promise<string>;
    isGameRunning(): Promise<boolean>;
    minimizeWindow(): Promise<void>;
    closeWindow(): Promise<void>;
    confirmCloseWindow(): Promise<boolean>;
    setSettings(patch: Record<string, unknown>): Promise<any>;
    getMintStatus(): Promise<any>;
    startMint(): Promise<any>;
    listServers(): Promise<any>;
    prepare(server: string): Promise<any>;
    launch(server: string): Promise<any>;
    cancel(targetId: number): Promise<any>;
    confirmTrust(data: Record<string, unknown>): Promise<any>;
    shutdownMint(): Promise<any>;
    on(channel: string, callback: (data: any) => void): () => void;
  }
}