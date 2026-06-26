import { invoke } from '@tauri-apps/api/core';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface ServerInfo {
  ip: string;
  port: number;
  url: string;
  readonlyPort: number;
  readonlyUrl: string;
  interactiveEnabled: boolean;
  readonlyEnabled: boolean;
}

export const nativeApi = {
  httpGet: (url: string) => invoke<string>('http_get', { url }),
  getServerInfo: () => invoke<ServerInfo>('get_server_info'),
  toggleInteractive: () => invoke<boolean>('toggle_interactive'),
  toggleReadonly: () => invoke<boolean>('toggle_readonly'),
  setSleepBlock: (block: boolean) => invoke<void>('set_sleep_block', { block }),
  openImageDialog: () => invoke<string | null>('open_image_dialog'),
  saveImage: (srcPath: string) => invoke<{ name: string; url: string }>('save_image', { srcPath }),
  listImages: () => invoke<{ name: string; url: string }[]>('list_images'),
  deleteImage: (name: string) => invoke<void>('delete_image', { name }),
  getImagesBaseUrl: () => invoke<string>('get_images_base_url'),
  scanNDI: () => invoke<string[]>('scan_ndi'),
};
