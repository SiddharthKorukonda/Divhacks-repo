import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { AudioLines, X } from 'lucide-react';
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
  const [isExpanded, setIsExpanded] = useState(false);

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
      console.log('Received transcription result:', segment);
      setTranscription((prev) => prev + ' ' + segment.text);
      setCurrentSegment('');
    });

    const cleanupTranscriptionDelta = window.electron?.ipcRenderer.on('transcription-delta', (segment: TranscriptionSegment) => {
      console.log('Received transcription delta:', segment);
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
    // Clear previous transcription
    setTranscription('');
    setCurrentSegment('');
    // Start recording (this will also start transcription)
    window.electron?.ipcRenderer.sendMessage('audio-start');
  };

  const handleStopRecording = () => {
    setStatus('Stopping...');
    // Stop recording (this will also stop transcription)
    window.electron?.ipcRenderer.sendMessage('audio-stop');
  };

  return (
    <div className="darkContainer">
      <div style={{ marginTop: '20px' }}>
        <button
          type="button"
          onClick={isRecording ? handleStopRecording : handleStartRecording}
          style={{
            padding: '20px',
            fontSize: '16px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '60px',
            height: '60px',
            borderRadius: '50%',
            backgroundColor: isRecording ? '#ff4444' : '#333',
            border: 'none',
            color: 'white',
            boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.15)',
          }}
        >
          {isRecording ? <X size={24} /> : <AudioLines size={24} />}
        </button>
      </div>

      {(transcription || currentSegment) && (
        <div style={{
          marginTop: '30px',
          padding: '15px',
          backgroundColor: '#f5f5f5',
          borderRadius: '8px',
          textAlign: 'left',
          width: '100%',
        }}>
          <h3 style={{ fontSize: '14px', marginBottom: '10px' }}>Transcription:</h3>
          <p style={{
            fontSize: '13px',
            lineHeight: '1.6',
            color: '#333',
            maxHeight: isExpanded ? 'none' : '150px',
            overflow: 'hidden',
            position: 'relative',
          }}>
            {transcription}
            {currentSegment && (
              <span style={{ color: '#666', fontStyle: 'italic' }}>
                {' '}{currentSegment}
              </span>
            )}
          </p>
          {(transcription + currentSegment).length > 200 && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              style={{
                marginTop: '10px',
                padding: '5px 10px',
                fontSize: '12px',
                backgroundColor: 'transparent',
                border: '1px solid #ccc',
                borderRadius: '4px',
                cursor: 'pointer',
                color: '#333',
                width: '100%',
              }}
            >
              {isExpanded ? 'Show Less' : 'Show More'}
            </button>
          )}
        </div>
      )}
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
