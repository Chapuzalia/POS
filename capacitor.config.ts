/// <reference types="@capawesome/capacitor-nodejs" />
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tickit.pos',
  appName: 'Tickit POS',
  webDir: 'dist',
  plugins: {
    // Backend de impresión embebido (dist/nodejs, generado por build:print-agent).
    Nodejs: { nodeDir: 'nodejs', startMode: 'auto' },
  },
};

export default config;
