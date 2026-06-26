import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gomolab.vmixcontrol',
  appName: 'GOMOLAB vMix Control',
  webDir: 'dist',
  server: {
    // Use native HTTP for all requests (bypasses CORS on Android)
    allowNavigation: ['*'],
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: true,
    captureInput: true,
  },
};

export default config;
