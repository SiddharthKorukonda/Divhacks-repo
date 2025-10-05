import React from 'react';
import '../VoiceFactUI.css';

interface OutputAreaProps {
  transcription: string;
  currentSegment: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

export default function OutputArea({ transcription, currentSegment, isExpanded, onToggleExpand }: OutputAreaProps) {
  return (
    <div>
      {(transcription || currentSegment) && (
        <div className="output-card">
          <h3 className="heading">Transcription:</h3>
          <p className="transcript">
            {transcription}
            {currentSegment && (<span className="delta"> {currentSegment}</span>)}
          </p>
          {(transcription + currentSegment).length > 200 && (
            <button className="expand-btn" onClick={onToggleExpand}>{isExpanded ? 'Show Less' : 'Show More'}</button>
          )}
        </div>
      )}
    </div>
  );
}
