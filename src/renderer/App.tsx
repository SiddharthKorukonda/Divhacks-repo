import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect } from 'react';
import icon from '../../assets/icon.svg';
import './App.css';

interface TranscriptionSegment {
  id: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
}

function Hello() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [chunkCount, setChunkCount] = useState(0);
  const [audioInfo, setAudioInfo] = useState<{
    sampleRate?: number;
    chunkDurationMs?: number;
    bufferSize?: number;
  }>({});
  const [transcription, setTranscription] = useState<string>('');
  const [currentSegment, setCurrentSegment] = useState<string>('');
  const [isSpeaking, setIsSpeaking] = useState(false);

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
    });

    const cleanupError = window.electron?.ipcRenderer.on('audio-error', (error: unknown) => {
      setStatus(`Error: ${error}`);
      setIsRecording(false);
      console.error('AudioTee error:', error);
    });

    // Transcription event listeners
    const cleanupTranscriptionConnected = window.electron?.ipcRenderer.on('transcription-connected', () => {
      setIsTranscribing(true);
      setStatus('Transcription connected');
    });

    const cleanupTranscriptionResult = window.electron?.ipcRenderer.on('transcription-result', (segment: TranscriptionSegment) => {
      setTranscription((prev) => prev + ' ' + segment.text);
      setCurrentSegment('');
    });

    const cleanupTranscriptionDelta = window.electron?.ipcRenderer.on('transcription-delta', (segment: TranscriptionSegment) => {
      setCurrentSegment(segment.text);
    });

    const cleanupSpeechStarted = window.electron?.ipcRenderer.on('transcription-speech-started', () => {
      setIsSpeaking(true);
    });

    const cleanupSpeechStopped = window.electron?.ipcRenderer.on('transcription-speech-stopped', () => {
      setIsSpeaking(false);
    });

    const cleanupTranscriptionError = window.electron?.ipcRenderer.on('transcription-error', (error: unknown) => {
      console.error('Transcription error:', error);
      setStatus(`Transcription error: ${error}`);
    });

    const cleanupTranscriptionDisconnected = window.electron?.ipcRenderer.on('transcription-disconnected', () => {
      setIsTranscribing(false);
      setStatus('Transcription disconnected');
    });

    return () => {
      cleanupStarted?.();
      cleanupStopped?.();
      cleanupData?.();
      cleanupError?.();
      cleanupTranscriptionConnected?.();
      cleanupTranscriptionResult?.();
      cleanupTranscriptionDelta?.();
      cleanupSpeechStarted?.();
      cleanupSpeechStopped?.();
      cleanupTranscriptionError?.();
      cleanupTranscriptionDisconnected?.();
    };
  }, []);

  const handleStartTranscription = () => {
    setStatus('Connecting to transcription service...');
    window.electron?.ipcRenderer.sendMessage('transcription-start');
  };

  const handleStopTranscription = () => {
    window.electron?.ipcRenderer.sendMessage('transcription-stop');
  };

  const handleStartRecording = () => {
    setStatus('Starting...');
    // Start transcription first
    if (!isTranscribing) {
      window.electron?.ipcRenderer.sendMessage('transcription-start');
    }
    // Then start recording
    window.electron?.ipcRenderer.sendMessage('audio-start');
  };

  const handleStopRecording = () => {
    setStatus('Stopping...');
    window.electron?.ipcRenderer.sendMessage('audio-stop');
    // Stop transcription when recording stops
    if (isTranscribing) {
      window.electron?.ipcRenderer.sendMessage('transcription-stop');
    }
  };

  return (
    <div>
      <div className="Hello">
        <img width="200" alt="icon" src={icon} />
      </div>
      <h1>Real-time Transcription</h1>
      <div className="Hello">
        <div style={{ margin: '20px 0' }}>
          <p><strong>Status:</strong> {status}</p>
          {isSpeaking && <p style={{ color: 'green' }}><strong>🎤 Speaking detected...</strong></p>}
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

        {(transcription || currentSegment) && (
          <div style={{
            marginTop: '30px',
            padding: '20px',
            backgroundColor: '#f5f5f5',
            borderRadius: '8px',
            textAlign: 'left',
          }}>
            <h3>Transcription:</h3>
            <p style={{ fontSize: '16px', lineHeight: '1.6', color: '#000' }}>
              {transcription}
              {currentSegment && (
                <span style={{ color: '#666', fontStyle: 'italic' }}>
                  {' '}{currentSegment}
                </span>
              )}
            </p>
          </div>
        )}
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
