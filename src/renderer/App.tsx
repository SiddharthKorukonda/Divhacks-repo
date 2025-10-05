import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { AudioLines, X } from 'lucide-react';
import { GoogleGenerativeAI } from '@google/generative-ai';
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
  const [transcription, setTranscription] = useState<string>(''); // Full transcript for display
  const [bufferTranscript, setBufferTranscript] = useState<string>(''); // Hidden buffer for backend
  const [currentSegment, setCurrentSegment] = useState<string>('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [factCheckResults, setFactCheckResults] = useState<any[]>([]); // Array of fact-check results
  const [expandedVerdicts, setExpandedVerdicts] = useState<Set<number>>(new Set([0])); // Track which verdicts are expanded (latest is 0)
  const [summary, setSummary] = useState<string>('');
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);

  // Poll backend every 15 seconds
  useEffect(() => {
    if (!isRecording) return;

    const pollInterval = setInterval(() => {
      setBufferTranscript((currentBuffer) => {
        const bufferToSend = currentBuffer.trim();

        // Only send if there's content
        if (!bufferToSend) {
          return currentBuffer;
        }

        console.log('=== POLLING BACKEND (15s) ===');
        console.log('Sending buffer:', bufferToSend);

        // Send to backend
        fetch('http://localhost:8080/transcribe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: bufferToSend,
            thread_id: 'session',
          }),
        })
        .then(response => {
          console.log('Backend response status:', response.status);
          if (response.ok) {
            return response.json();
          } else {
            console.error('Backend returned error status:', response.status);
            return null;
          }
        })
        .then(result => {
          if (result) {
            console.log('Fact-check result:', result);
            // If it's a claim that was fact-checked, display it
            if (result.status === 'fact_checked') {
              console.log('Displaying fact-check result');
              const resultWithClaim = {
                ...result,
                claim: bufferToSend,
                timestamp: Date.now()
              };
              setFactCheckResults(prev => [resultWithClaim, ...prev]);
              setExpandedVerdicts(new Set([0]));
            } else {
              console.log('Not a claim');
            }
          }
        })
        .catch(error => {
          console.error('Failed to fact-check:', error);
        });

        // Clear buffer immediately after posting
        return '';
      });
    }, 15000); // 15 seconds

    return () => clearInterval(pollInterval);
  }, [isRecording]);

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

    const cleanupTranscriptionResult = window.electron?.ipcRenderer.on('transcription-result', async (segment: TranscriptionSegment) => {
      console.log('Received transcription result:', segment);
      const newText = segment.text;

      // Update display transcript
      setTranscription((prev) => prev + ' ' + newText);

      // Update buffer transcript (will be sent on next 15s interval)
      setBufferTranscript((prevBuffer) => (prevBuffer + ' ' + newText).trim());

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
    // Clear previous transcription and buffer
    setTranscription('');
    setBufferTranscript('');
    setCurrentSegment('');
    setFactCheckResults([]);
    setExpandedVerdicts(new Set([0]));
    setSummary('');
    setIsGeneratingSummary(false);
    // Start recording (this will also start transcription)
    window.electron?.ipcRenderer.sendMessage('audio-start');
  };

  const handleStopRecording = async () => {
    setStatus('Stopping...');
    // Stop recording (this will also stop transcription and disconnect websocket)
    window.electron?.ipcRenderer.sendMessage('audio-stop');

    // Generate summary if we have fact-check results
    if (factCheckResults.length > 0) {
      setIsGeneratingSummary(true);
      try {
        // Initialize Gemini
        const apiKey = process.env.GOOGLE_API_KEY || '';
        if (!apiKey) {
          throw new Error('GOOGLE_API_KEY not found in environment variables');
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

        // Format verdicts for summary
        const verdictsText = factCheckResults
          .map(
            (v) =>
              `Claim: ${v.claim || 'N/A'}\n` +
              `Verdict: ${v.verdict || 'N/A'}\n` +
              `Explanation: ${v.explanation || 'N/A'}`
          )
          .join('\n\n');

        const prompt =
          'You are summarizing fact-check results from a live speech or presentation.\n\n' +
          'Provide a concise summary (3-5 sentences) that includes:\n' +
          '1. Overall truthfulness assessment (how many claims were true/false/unsubstantiated)\n' +
          '2. Key findings or patterns in the misinformation\n' +
          '3. Most significant false or misleading claims\n\n' +
          `Fact-check results:\n${verdictsText}\n\n` +
          'Write the summary in a clear, journalistic style.';

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const summaryText = response.text();

        setSummary(summaryText);
      } catch (error) {
        console.error('Error generating summary:', error);
        setSummary(`Error generating summary: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } finally {
        setIsGeneratingSummary(false);
      }
    }
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

      {/* Summary Section */}
      {isGeneratingSummary && (
        <div style={{
          marginTop: '20px',
          padding: '20px',
          backgroundColor: '#f0f0f0',
          borderRadius: '8px',
          textAlign: 'center',
          width: '100%',
        }}>
          <h3 style={{ fontSize: '16px', marginBottom: '10px', fontWeight: 'bold' }}>
            Generating Summary...
          </h3>
          <div style={{
            display: 'inline-block',
            width: '40px',
            height: '40px',
            border: '4px solid #ddd',
            borderTop: '4px solid #333',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
        </div>
      )}

      {!isGeneratingSummary && summary && (
        <div style={{
          marginTop: '20px',
          padding: '20px',
          backgroundColor: '#e8f4f8',
          borderRadius: '8px',
          borderLeft: '4px solid #0066cc',
          width: '100%',
        }}>
          <h3 style={{ fontSize: '16px', marginBottom: '10px', fontWeight: 'bold', color: '#0066cc' }}>
            Overall Summary
          </h3>
          <p style={{ fontSize: '14px', lineHeight: '1.6', color: '#333', whiteSpace: 'pre-wrap' }}>
            {summary}
          </p>
        </div>
      )}

      {/* Verdicts Section */}
      {factCheckResults.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          {factCheckResults.map((result, index) => {
            const isExpanded = expandedVerdicts.has(index);
            const toggleExpand = () => {
              setExpandedVerdicts(prev => {
                const newSet = new Set(prev);
                if (newSet.has(index)) {
                  newSet.delete(index);
                } else {
                  newSet.add(index);
                }
                return newSet;
              });
            };

            return (
              <div key={result.timestamp} style={{
                marginBottom: '10px',
                padding: '15px',
                backgroundColor: result.verdict === 'true' ? '#d4edda' :
                                result.verdict === 'false' ? '#f8d7da' : '#fff3cd',
                borderRadius: '8px',
                textAlign: 'left',
                width: '100%',
                cursor: 'pointer',
              }}
              onClick={toggleExpand}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 'bold', margin: 0 }}>
                    Verdict: {result.verdict}
                  </h3>
                  <span style={{ fontSize: '12px', color: '#666' }}>
                    {isExpanded ? '▼' : '▶'}
                  </span>
                </div>

                {isExpanded && (
                  <>
                    <div style={{
                      marginTop: '10px',
                      padding: '10px',
                      backgroundColor: 'rgba(255,255,255,0.5)',
                      borderRadius: '4px',
                      borderLeft: '3px solid #666'
                    }}>
                      <h4 style={{ fontSize: '11px', marginBottom: '5px', fontWeight: 'bold', color: '#666' }}>
                        Claim:
                      </h4>
                      <p style={{ fontSize: '12px', lineHeight: '1.4', color: '#333', margin: 0 }}>
                        {result.claim}
                      </p>
                    </div>

                    <p style={{ fontSize: '13px', lineHeight: '1.6', color: '#333', margin: '10px 0' }}>
                      {result.explanation}
                    </p>

                    {result.citations && result.citations.length > 0 && (
                      <div style={{ marginTop: '10px' }}>
                        <h4 style={{ fontSize: '12px', marginBottom: '5px', fontWeight: 'bold' }}>Citations:</h4>
                        {result.citations.map((citation: any, idx: number) => (
                          <div key={idx} style={{ fontSize: '11px', marginBottom: '5px' }}>
                            <a href={citation.url} target="_blank" rel="noopener noreferrer"
                               style={{ color: '#007bff' }}
                               onClick={(e) => e.stopPropagation()}>
                              {citation.title}
                            </a>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
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
