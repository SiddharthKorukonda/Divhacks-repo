import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect } from 'react';
import icon from '../../assets/icon.svg';
import './App.css';

function Hello() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [chunkCount, setChunkCount] = useState(0);
  const [audioInfo, setAudioInfo] = useState<{
    sampleRate?: number;
    chunkDurationMs?: number;
    bufferSize?: number;
  }>({});

  useEffect(() => {
    // Set up listeners for AudioTee events
    const cleanupStarted = window.electron?.ipcRenderer.on('audio-started', () => {
      setStatus('Recording...');
      setIsRecording(true);
      setChunkCount(0);
      setAudioInfo({});
    });

    const cleanupStopped = window.electron?.ipcRenderer.on('audio-stopped', () => {
      setStatus('Stopped');
      setIsRecording(false);
    });

    const cleanupData = window.electron?.ipcRenderer.on('audio-data', (data: any) => {
      setChunkCount((prev) => prev + 1);
      setAudioInfo({
        sampleRate: data.sampleRate,
        chunkDurationMs: data.chunkDurationMs,
        bufferSize: data.length,
      });

      // Log actual audio data
      const buffer = data.buffer;
      console.log('Raw audio chunk:', buffer);

      // Convert to array for inspection if it's a Buffer/Uint8Array
      if (buffer) {
        const samples = Array.from(buffer).slice(0, 20); // First 20 samples
        console.log('First 20 samples:', samples);
        console.log('Chunk metadata:', {
          length: data.length,
          sampleRate: data.sampleRate,
          chunkDurationMs: data.chunkDurationMs,
          bufferType: buffer.constructor.name,
        });
      }
    });

    const cleanupError = window.electron?.ipcRenderer.on('audio-error', (error: unknown) => {
      setStatus(`Error: ${error}`);
      setIsRecording(false);
      console.error('AudioTee error:', error);
    });

    return () => {
      cleanupStarted?.();
      cleanupStopped?.();
      cleanupData?.();
      cleanupError?.();
    };
  }, []);

  const handleStartRecording = () => {
    setStatus('Starting...');
    window.electron?.ipcRenderer.sendMessage('audio-start');
  };

  const handleStopRecording = () => {
    setStatus('Stopping...');
    window.electron?.ipcRenderer.sendMessage('audio-stop');
  };

  return (
    <div>
      <div className="Hello">
        <img width="200" alt="icon" src={icon} />
      </div>
      <h1>AudioTee Test</h1>
      <div className="Hello">
        <div style={{ margin: '20px 0' }}>
          <p><strong>Status:</strong> {status}</p>
          {isRecording && (
            <>
              <p><strong>Audio chunks received:</strong> {chunkCount}</p>
              {audioInfo.sampleRate && (
                <>
                  <p><strong>Sample Rate:</strong> {audioInfo.sampleRate} Hz</p>
                  <p><strong>Chunk Duration:</strong> {audioInfo.chunkDurationMs} ms</p>
                  <p><strong>Buffer Size:</strong> {audioInfo.bufferSize} bytes</p>
                </>
              )}
            </>
          )}
        </div>
        <div>
          <button
            type="button"
            onClick={handleStartRecording}
            disabled={isRecording}
            style={{
              padding: '10px 20px',
              margin: '5px',
              fontSize: '16px',
              cursor: isRecording ? 'not-allowed' : 'pointer',
              opacity: isRecording ? 0.5 : 1,
            }}
          >
            Start Recording
          </button>
          <button
            type="button"
            onClick={handleStopRecording}
            disabled={!isRecording}
            style={{
              padding: '10px 20px',
              margin: '5px',
              fontSize: '16px',
              cursor: !isRecording ? 'not-allowed' : 'pointer',
              opacity: !isRecording ? 0.5 : 1,
            }}
          >
            Stop Recording
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Hello />} />
      </Routes>
    </Router>
  );
}
