# GOMOLAB vMix Control — Setup Guide

A cross-platform vMix controller for **macOS** (Electron desktop app) and **Android** (native app via Capacitor).

## Requirements

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | Already installed |
| Android Studio | Latest | https://developer.android.com/studio (for Android builds only) |
| Java JDK | 17+ | Bundled with Android Studio |

## Step 1 — Install dependencies

```bash
cd ~/Desktop/GOMOLAB-vMixControl
npm install
```

---

## Run on macOS (Electron)

### Development mode
```bash
npm run dev          # Start Vite dev server (port 5173)
npm run electron:dev # In a second terminal: launch Electron window
```

### Production build
```bash
npm run electron:build
```

---

## Run on Android

### One-time setup
```bash
npm run build           # Build the web app
npm run android:add     # Add the Android platform (creates ./android/ folder)
npm run android:sync    # Sync web build to Android project
npm run android:open    # Open in Android Studio
```

In Android Studio:
1. Wait for Gradle sync to finish
2. Connect your Android phone (enable USB debugging) or start an emulator
3. Click **▶ Run**

### After each code change
```bash
npm run android:sync    # Rebuild + sync
npm run android:open    # Re-run from Android Studio
```

---

## vMix Setup

In vMix on the Windows PC:
1. Go to **Settings → Web Controller**
2. Enable the API
3. Note the port (default **8088**)
4. Make sure your Mac/Android is on the **same network** as the vMix PC

In the app, enter the Windows PC's IP address (e.g. `192.168.1.50`) and port `8088`.

---

## Project Structure

```
src/
  api/vmixApi.ts        — vMix HTTP client, XML parser, polling
  stores/vmixStore.ts   — Zustand state (connection, vMix state, shortcuts)
  types/vmix.ts         — TypeScript types
  components/
    ConnectionSetup.tsx — Login screen
    StatusBar.tsx       — Header (PRV/PGM tallies, REC/STREAM)
    InputList.tsx       — Scrollable input list with PRV/PGM buttons
    TitleEditor.tsx     — Text field editor for GT titles
    TransitionControls  — CUT / FADE / AUTO / T2 / T3 buttons
    ShortcutPanel.tsx   — Configurable quick-fire buttons
electron/
  main.cjs              — Electron main process (webSecurity disabled for CORS)
  preload.cjs           — Electron preload script
capacitor.config.ts     — Capacitor / Android config
```

---

## Key Features

- **Live vMix state** — polls every 800 ms, shows all inputs
- **Title editing** — tap any GT input → edit text fields live (debounced)
- **Tally display** — PRV (green) and PGM (red) numbers always visible
- **PRV / PGM routing** — send any input to preview or program
- **Transitions** — CUT, FADE, AUTO, T2, T3
- **Record / Stream / FTB** toggle from the header
- **Shortcuts** — configurable buttons for any vMix function + params
- **Saved connections** — remembers up to 10 hosts
- **Responsive** — portrait mobile layout switches to horizontal input strip
