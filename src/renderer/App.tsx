import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { AudioLines, X } from 'lucide-react';
import { GoogleGenerativeAI } from '@google/generative-ai';
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
  const [audioInfo, setAudioInfo] = useState<{ sampleRate?: number; chunkDurationMs?: number; bufferSize?: number; }>({});
  const [transcription, setTranscription] = useState<string>('');
  const [bufferTranscript, setBufferTranscript] = useState<string>('');
  const [currentSegment, setCurrentSegment] = useState<string>('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [factCheckResults, setFactCheckResults] = useState<any[]>([]);
  const [expandedVerdicts, setExpandedVerdicts] = useState<Set<number>>(new Set([0]));
  const [summary, setSummary] = useState<string>('');
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);

  // Poll backend every 15 seconds while recording
  useEffect(() => {
    if (!isRecording) return;

    const pollInterval = setInterval(() => {
      setBufferTranscript((currentBuffer) => {
        const bufferToSend = currentBuffer.trim();
        if (!bufferToSend) return currentBuffer;

        fetch('http://localhost:8080/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: bufferToSend, thread_id: 'session' }),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((result) => {
            if (result && result.status === 'fact_checked') {
              const resultWithClaim = { ...result, claim: bufferToSend, timestamp: Date.now() };
              setFactCheckResults((prev) => [resultWithClaim, ...prev]);
              setExpandedVerdicts(new Set([0]));
            }
          })
          .catch((err) => console.error('Failed to fact-check:', err));

        return '';
      });
    }, 15000);

    return () => clearInterval(pollInterval);
  }, [isRecording]);

  useEffect(() => {
    // Audio / transcription IPC listeners
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
      setAudioInfo({ sampleRate: data.sampleRate, chunkDurationMs: data.chunkDurationMs, bufferSize: data.length });
    });

    const cleanupError = window.electron?.ipcRenderer.on('audio-error', (error: unknown) => {
      setStatus(`Error: ${error}`);
      setIsRecording(false);
      console.error('AudioTee error:', error);
    });

    const cleanupTranscriptionConnected = window.electron?.ipcRenderer.on('transcription-connected', () => {
      setIsTranscribing(true);
      setStatus('Transcription connected');
    });

    const cleanupTranscriptionResult = window.electron?.ipcRenderer.on(
      'transcription-result',
      async (segment: TranscriptionSegment) => {
        const newText = segment.text;
        setTranscription((prev) => (prev ? prev + ' ' + newText : newText));
        setBufferTranscript((prevBuffer) => (prevBuffer + ' ' + newText).trim());
        setCurrentSegment('');
      }
    );

    const cleanupTranscriptionDelta = window.electron?.ipcRenderer.on(
      'transcription-delta',
      (segment: TranscriptionSegment) => setCurrentSegment(segment.text)
    );

    const cleanupSpeechStarted = window.electron?.ipcRenderer.on('transcription-speech-started', () => setIsSpeaking(true));
    const cleanupSpeechStopped  = window.electron?.ipcRenderer.on('transcription-speech-stopped',  () => setIsSpeaking(false));

    const cleanupTranscriptionError = window.electron?.ipcRenderer.on(
      'transcription-error',
      (error: unknown) => {
        console.error('Transcription error:', error);
        setStatus(`Transcription error: ${error}`);
      }
    );

    const cleanupTranscriptionDisconnected = window.electron?.ipcRenderer.on('transcription-disconnected', () => {
      setIsTranscribing(false);
      setStatus('Transcription disconnected');
    });

    return () => {
      cleanupStarted?.(); cleanupStopped?.(); cleanupData?.(); cleanupError?.();
      cleanupTranscriptionConnected?.(); cleanupTranscriptionResult?.(); cleanupTranscriptionDelta?.();
      cleanupSpeechStarted?.(); cleanupSpeechStopped?.(); cleanupTranscriptionError?.(); cleanupTranscriptionDisconnected?.();
    };
  }, []);

  const handleStartRecording = () => {
    setStatus('Starting...');
    setTranscription('');
    setBufferTranscript('');
    setCurrentSegment('');
    setFactCheckResults([]);
    setExpandedVerdicts(new Set([0]));
    setSummary('');
    setIsGeneratingSummary(false);
    window.electron?.ipcRenderer.sendMessage('audio-start');
  };

  const handleStopRecording = async () => {
    setStatus('Stopping...');
    window.electron?.ipcRenderer.sendMessage('audio-stop');

    if (factCheckResults.length > 0) {
      setIsGeneratingSummary(true);
      try {
        const apiKey = process.env.GOOGLE_API_KEY || '';
        if (!apiKey) throw new Error('GOOGLE_API_KEY not found in environment variables');

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

        const verdictsText = factCheckResults
          .map((v) => `Claim: ${v.claim || 'N/A'}\nVerdict: ${v.verdict || 'N/A'}\nExplanation: ${v.explanation || 'N/A'}`)
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

  // --- Layout constants ---
  const COLUMN_MAX = 760;  // centered column width
  const H_PADDING  = 16;   // inner horizontal padding
  const V_GAP      = 16;   // vertical gap between blocks
  const FIXED_BTN_TOP = 16;
  const BTN_HEIGHT = 56;
  const SAFE_TOP_PADDING = FIXED_BTN_TOP + BTN_HEIGHT + 24;

  return (
    // SCROLL CONTAINER — unchanged (keeps scrolling solid)
    <div
      style={{
        height: '100vh',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        position: 'relative',
        background: 'transparent', // let our custom glass background show through
      }}
    >
      {/* GLASS / LIQUID BACKGROUND (new) */}
      <div
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
        }}
      >
        {/* Base gradient (matches original blue scheme, slightly richer) */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(180deg, rgba(139,211,234,0.85) 0%, rgba(95,180,212,0.85) 100%)',
          }}
        />
        {/* Soft “liquid” blobs */}
        <div
          style={{
            position: 'absolute',
            top: '-12%',
            left: '-10%',
            width: '60vw',
            height: '60vw',
            background:
              'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.50), rgba(255,255,255,0) 55%)',
            filter: 'blur(60px)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: '-15%',
            right: '-10%',
            width: '65vw',
            height: '65vw',
            background:
              'radial-gradient(circle at 70% 70%, rgba(0,102,204,0.25), rgba(0,102,204,0) 60%)',
            filter: 'blur(70px)',
          }}
        />
        {/* Subtle vignette for depth */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse at center, rgba(255,255,255,0) 40%, rgba(0,0,0,0.08) 100%)',
          }}
        />
      </div>

      {/* Top-centered oval record button (fixed to viewport) */}
      <div
        style={{
          position: 'fixed',
          top: FIXED_BTN_TOP,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 2, // above background
          WebkitAppRegion: 'no-drag' as 'no-drag',
          backdropFilter: 'saturate(140%) blur(6px)', // slight glass on the button area
        }}
      >
        <button
          type="button"
          onClick={isRecording ? handleStopRecording : handleStartRecording}
          style={{
            padding: '0 18px',
            fontSize: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 180,
            height: BTN_HEIGHT,
            borderRadius: 9999,
            backgroundColor: isRecording ? 'rgba(255,68,68,0.92)' : 'rgba(51,51,51,0.92)',
            border: '4px solid rgba(255,200,97,0.95)',
            color: 'white',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            cursor: 'pointer',
            gap: 8,
            WebkitAppRegion: 'no-drag' as 'no-drag',
          }}
        >
          {isRecording ? <X size={20} /> : <AudioLines size={20} />}
          <span style={{ userSelect: 'none' }}>{isRecording ? 'Stop' : 'Record'}</span>
        </button>
      </div>

      {/* CONTENT WRAPPER — centered column with equal left/right borders */}
      <div
        style={{
          minHeight: '100%',
          boxSizing: 'border-box',
          paddingTop: SAFE_TOP_PADDING,
          paddingBottom: 24,
          position: 'relative',
          zIndex: 1, // above background
        }}
      >
        <div
          style={{
            maxWidth: COLUMN_MAX,
            margin: '0 auto',
            padding: `0 ${H_PADDING}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: V_GAP,
            boxSizing: 'border-box',
          }}
        >
          {/* Transcript */}
          {(transcription || currentSegment) && (
            <div
              style={{
                padding: 16,
                backgroundColor: 'rgba(245,245,245,0.92)',
                borderRadius: 10,
                textAlign: 'left',
                boxShadow: '0 1px 6px rgba(0,0,0,0.12)',
                backdropFilter: 'saturate(130%) blur(4px)',
              }}
            >
              <h3 style={{ fontSize: 16, margin: '0 0 8px 0' }}>Transcript</h3>
              <p
                style={{
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: '#333',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: isExpanded ? 'none' : 220,
                  overflow: 'hidden',
                }}
              >
                {transcription}
                {currentSegment && (
                  <span style={{ color: '#666', fontStyle: 'italic' }}>
                    {' '}{currentSegment}
                  </span>
                )}
              </p>
              {(transcription + currentSegment).length > 300 && (
                <button
                  onClick={() => setIsExpanded(!isExpanded)}
                  style={{
                    marginTop: 10,
                    padding: '6px 10px',
                    fontSize: 12,
                    backgroundColor: 'transparent',
                    border: '1px solid #ccc',
                    borderRadius: 6,
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

          {/* Verdicts — stacked vertically */}
          {factCheckResults.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: V_GAP }}>
              {factCheckResults.map((result, index) => {
                const expanded = expandedVerdicts.has(index);
                const toggleExpand = () => {
                  setExpandedVerdicts((prev) => {
                    const ns = new Set(prev);
                    ns.has(index) ? ns.delete(index) : ns.add(index);
                    return ns;
                  });
                };

                const cardBg =
                  result.verdict === 'true'
                    ? 'rgba(223,243,228,0.92)'
                    : result.verdict === 'false'
                    ? 'rgba(253,226,224,0.92)'
                    : 'rgba(255,242,204,0.92)';

                return (
                  <div
                    key={result.timestamp}
                    style={{
                      padding: 16,
                      backgroundColor: cardBg,
                      borderRadius: 10,
                      boxShadow: '0 1px 6px rgba(0,0,0,0.12)',
                      cursor: 'pointer',
                      backdropFilter: 'saturate(130%) blur(4px)',
                    }}
                    onClick={toggleExpand}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
                        Verdict: {result.verdict}
                      </h3>
                      <span style={{ fontSize: 12, color: '#555' }}>
                        {expanded ? '▼' : '▶'}
                      </span>
                    </div>

                    {expanded && (
                      <>
                        <div
                          style={{
                            marginTop: 12,
                            padding: 12,
                            backgroundColor: 'rgba(255,255,255,0.75)',
                            borderLeft: '3px solid #666',
                            borderRadius: 6,
                          }}
                        >
                          <h4 style={{ fontSize: 12, margin: '0 0 6px 0', color: '#555', fontWeight: 700 }}>
                            Claim
                          </h4>
                          <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5, wordBreak: 'break-word' }}>
                            {result.claim}
                          </p>
                        </div>

                        {result.explanation && (
                          <p style={{ fontSize: 14, lineHeight: 1.6, color: '#333', margin: '12px 0 0 0' }}>
                            {result.explanation}
                          </p>
                        )}

                        {result.citations && result.citations.length > 0 && (
                          <div style={{ marginTop: 12 }}>
                            <h4 style={{ fontSize: 12, margin: '0 0 6px 0', fontWeight: 700, color: '#333' }}>
                              Citations
                            </h4>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {result.citations.map((c: any, i: number) => (
                                <a
                                  key={i}
                                  href={c.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ fontSize: 12, color: '#0066cc', wordBreak: 'break-all' }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {c.title}
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Overall Summary — last block */}
          {isGeneratingSummary && (
            <div
              style={{
                padding: 20,
                backgroundColor: 'rgba(240,240,240,0.92)',
                borderRadius: 10,
                textAlign: 'center',
                boxShadow: '0 1px 6px rgba(0,0,0,0.12)',
                backdropFilter: 'saturate(130%) blur(4px)',
              }}
            >
              <h3 style={{ fontSize: 16, margin: '0 0 10px 0', fontWeight: 700 }}>
                Generating Overall Summary…
              </h3>
              <div
                style={{
                  display: 'inline-block',
                  width: 40,
                  height: 40,
                  border: '4px solid #ddd',
                  borderTop: '4px solid #333',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                }}
              />
            </div>
          )}

          {!isGeneratingSummary && summary && (
            <div
              style={{
                padding: 20,
                backgroundColor: 'rgba(232,244,248,0.92)',
                borderRadius: 10,
                borderLeft: '4px solid rgba(0,102,204,0.9)',
                boxShadow: '0 1px 6px rgba(0,0,0,0.12)',
                backdropFilter: 'saturate(130%) blur(4px)',
              }}
            >
              <h3 style={{ fontSize: 18, margin: '0 0 10px 0', fontWeight: 800, color: '#0066cc' }}>
                Overall Summary
              </h3>
              <p style={{ fontSize: 14, lineHeight: 1.6, color: '#0f172a', whiteSpace: 'pre-wrap', margin: 0 }}>
                {summary}
              </p>
            </div>
          )}
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
