import React from 'react';
import { AudioLines, X } from 'lucide-react';
import '../VoiceFactUI.css';

interface VoiceButtonProps {
  isRecording: boolean;
  onToggle: () => void;
}

export default function VoiceButton({ isRecording, onToggle }: VoiceButtonProps) {
  return (
    <div style={{ marginTop: '20px' }}>
      <button
        type="button"
        onClick={onToggle}
        className={`voice-btn ${isRecording ? 'recording' : ''} no-drag`}
        aria-pressed={isRecording}
        aria-label={isRecording ? 'Stop recording' : 'Start recording'}
      >
        {isRecording ? <X size={24} /> : <AudioLines size={24} />}
      </button>
    </div>
  );
}
