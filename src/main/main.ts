/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { AudioTee, AudioChunk } from 'audiotee';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import { RealtimeTranscriptionService, TranscriptionSegment } from './transcriptionService';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;
let audioTee: AudioTee | null = null;
let transcriptionService: RealtimeTranscriptionService | null = null;

// Debug: Log environment on startup
console.log('=== Environment Check ===');
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'FOUND' : 'NOT FOUND');
console.log('All OPENAI keys:', Object.keys(process.env).filter(k => k.includes('OPENAI')));

// Audio detection helper - checks if buffer contains audio above threshold
function detectAudio(buffer: Buffer, threshold: number = 500): boolean {
  // Convert buffer to 16-bit PCM samples
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);

  // Calculate RMS (Root Mean Square) energy
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSquares / samples.length);

  return rms > threshold;
}

ipcMain.on('ipc-example', async (event, arg) => {
  const msgTemplate = (pingPong: string) => `IPC test: ${pingPong}`;
  console.log(msgTemplate(arg));
  event.reply('ipc-example', msgTemplate('pong'));
});

// Transcription IPC handlers
ipcMain.on('transcription-start', async (event) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    console.log('API Key check:', apiKey ? `Found (${apiKey.substring(0, 10)}...)` : 'NOT FOUND');
    console.log('All env vars:', Object.keys(process.env).filter(k => k.includes('OPENAI')));

    if (!apiKey) {
      console.error('OPENAI_API_KEY not found in environment');
      event.reply('transcription-error', 'OPENAI_API_KEY not configured');
      return;
    }

    // Always create a fresh transcription service
    if (transcriptionService) {
      console.log('Disconnecting existing transcription service...');
      transcriptionService.disconnect();
      transcriptionService = null;
    }

    console.log('Creating transcription service...');
    transcriptionService = new RealtimeTranscriptionService({
      apiKey,
      model: 'gpt-4o-transcribe',
      language: 'en',
    });

    // Set up transcription event listeners
    transcriptionService.on('connected', () => {
      console.log('Transcription service connected');
      event.reply('transcription-connected');
    });

    transcriptionService.on('transcription', (segment: TranscriptionSegment) => {
      console.log('Final transcription:', segment.text);
      event.reply('transcription-result', segment);
    });

    transcriptionService.on('transcription_delta', (segment: TranscriptionSegment) => {
      console.log('Transcription delta:', segment.text);
      event.reply('transcription-delta', segment);
    });

    transcriptionService.on('speech_started', () => {
      event.reply('transcription-speech-started');
    });

    transcriptionService.on('speech_stopped', () => {
      event.reply('transcription-speech-stopped');
    });

    transcriptionService.on('error', (error: Error) => {
      console.error('Transcription error:', error);
      event.reply('transcription-error', error.message);
    });

    transcriptionService.on('disconnected', () => {
      event.reply('transcription-disconnected');
    });

    await transcriptionService.connect();
  } catch (error) {
    console.error('Failed to start transcription:', error);
    event.reply('transcription-error', error instanceof Error ? error.message : 'Unknown error');
  }
});

ipcMain.on('transcription-stop', async (event) => {
  if (transcriptionService) {
    transcriptionService.disconnect();
    transcriptionService = null;
  }
});

// AudioTee IPC handlers
ipcMain.on('audio-start', async (event) => {
  try {
    // Start transcription service first
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.error('OPENAI_API_KEY not found in environment');
      event.reply('transcription-error', 'OPENAI_API_KEY not configured');
      return;
    }

    // Always create a fresh transcription service
    if (transcriptionService) {
      console.log('Disconnecting existing transcription service...');
      transcriptionService.disconnect();
      transcriptionService = null;
    }

    console.log('Creating transcription service...');
    transcriptionService = new RealtimeTranscriptionService({
      apiKey,
      model: 'gpt-4o-transcribe',
      language: 'en',
    });

    // Set up transcription event listeners
    transcriptionService.on('connected', () => {
      console.log('Transcription service connected');
      event.reply('transcription-connected');
    });

    transcriptionService.on('transcription', (segment: TranscriptionSegment) => {
      console.log('Final transcription:', segment.text);
      event.reply('transcription-result', segment);
    });

    transcriptionService.on('transcription_delta', (segment: TranscriptionSegment) => {
      console.log('Transcription delta:', segment.text);
      event.reply('transcription-delta', segment);
    });

    transcriptionService.on('speech_started', () => {
      event.reply('transcription-speech-started');
    });

    transcriptionService.on('speech_stopped', () => {
      event.reply('transcription-speech-stopped');
    });

    transcriptionService.on('error', (error: Error) => {
      console.error('Transcription error:', error);
      event.reply('transcription-error', error.message);
    });

    transcriptionService.on('disconnected', () => {
      event.reply('transcription-disconnected');
    });

    await transcriptionService.connect();

    // Then start audio recording
    if (!audioTee) {
      console.log('Creating AudioTee instance...');
      audioTee = new AudioTee({ sampleRate: 16000, chunkDurationMs: 200 });

      audioTee.on('data', (chunk: AudioChunk) => {
        event.reply('audio-data', {
          buffer: chunk.data,
          length: chunk.data.length,
          sampleRate: 16000,
          chunkDurationMs: 200,
        });

        // Send audio chunk to transcription service if connected
        // Only send if there's actual audio (not silence)
        if (transcriptionService && transcriptionService.isConnectedToAPI()) {
          const hasAudio = detectAudio(chunk.data);
          if (hasAudio) {
            transcriptionService.sendAudioChunk(chunk.data);
          }
        }
      });

      audioTee.on('start', () => {
        console.log('AudioTee started successfully');
        event.reply('audio-started');
      });

      audioTee.on('stop', () => {
        console.log('AudioTee stopped');
        event.reply('audio-stopped');
      });

      audioTee.on('error', (error: Error) => {
        console.error('AudioTee error:', error);
        event.reply('audio-error', error.message);
      });

      audioTee.on('log', (level, message) => {
        console.log(`AudioTee [${level}]:`, message);
        event.reply('audio-log', { level, message });
      });
    }

    console.log('Starting AudioTee...');
    await audioTee.start();
    console.log('AudioTee start() completed');
  } catch (error) {
    console.error('Failed to start AudioTee:', error);
    event.reply('audio-error', error instanceof Error ? error.message : 'Unknown error');
  }
});

ipcMain.on('audio-stop', async (event) => {
  try {
    if (audioTee) {
      await audioTee.stop();
      audioTee = null;
    }

    // Stop transcription service
    if (transcriptionService) {
      transcriptionService.disconnect();
      transcriptionService = null;
    }
  } catch (error) {
    console.error('Failed to stop AudioTee:', error);
    event.reply('audio-error', error instanceof Error ? error.message : 'Unknown error');
  }
});

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
