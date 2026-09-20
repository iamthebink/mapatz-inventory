export interface DesktopBridge {
  saveWorkbook(bytes: Uint8Array): Promise<'saved' | 'cancelled'>;
  onCloseRequest(listener: () => void): () => void;
  approveClose(): void;
  onResume(listener: () => void): () => void;
}
declare global {
  interface Window {
    mapatzDesktop?: DesktopBridge;
  }
}
export const desktop = typeof window === 'undefined' ? undefined : window.mapatzDesktop;
