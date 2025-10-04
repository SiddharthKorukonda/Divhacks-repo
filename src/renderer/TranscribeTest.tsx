import { useState } from 'react';
// @ts-ignore
import createModule from '../../assets/shout.wasm.js';
import { FileTranscriber } from '@transcribe/transcriber';

export default function TranscribeTest() {
  const [transcription, setTranscription] = useState('');
  const [loading, setLoading] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setTranscription('Initializing transcriber...');

    try {
      const Module = await createModule();
      const transcriber = new FileTranscriber(Module, {
        model: '/assets/ggml-tiny.en-q5_1.bin',
      });

      setTranscription('Transcribing...');

      const result = await transcriber.transcribe(file);

      setTranscription(
        result.segments.map((s: any) => s.text).join(' ')
      );
    } catch (error) {
      setTranscription(`Error: ${error}`);
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h2>Test Whisper Model</h2>
      <input
        type="file"
        accept="audio/*"
        onChange={handleFileUpload}
        disabled={loading}
      />
      {transcription && (
        <div style={{
          marginTop: '20px',
          padding: '15px',
          backgroundColor: '#f5f5f5',
          borderRadius: '8px',
        }}>
          <strong>Transcription:</strong>
          <p>{transcription}</p>
        </div>
      )}
    </div>
  );
}
