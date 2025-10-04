import WebSocket from 'ws';
import { EventEmitter } from 'events';

interface TranscriptionConfig {
  apiKey: string;
  model?: 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe' | 'whisper-1';
  language?: string;
  vadThreshold?: number;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
}

export interface TranscriptionSegment {
  id: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
}

export class RealtimeTranscriptionService extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: TranscriptionConfig;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private commitInterval: NodeJS.Timeout | null = null;

  constructor(config: TranscriptionConfig) {
    super();
    this.config = {
      model: 'gpt-4o-transcribe',
      vadThreshold: 0.5,
      prefixPaddingMs: 300,
      silenceDurationMs: 500,
      ...config,
    };
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Connect to OpenAI Realtime API
        this.ws = new WebSocket(
          'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
          {
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              'OpenAI-Beta': 'realtime=v1',
            },
          }
        );

        this.ws.on('open', () => {
          console.log('Connected to OpenAI Realtime API');
          this.isConnected = true;
          this.reconnectAttempts = 0;

          // Configure transcription session
          this.sendSessionUpdate();

          // Start periodic commit to trigger transcription every 2 seconds
          this.commitInterval = setInterval(() => {
            this.commitAudioBuffer();
          }, 2000);

          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
          this.emit('error', error);
          reject(error);
        });

        this.ws.on('close', () => {
          console.log('WebSocket connection closed');
          this.isConnected = false;
          this.emit('disconnected');
          this.handleReconnect();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private sendSessionUpdate(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const sessionConfig = {
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: '',
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: null, // Disable VAD for continuous transcription
      },
    };

    this.ws.send(JSON.stringify(sessionConfig));
    console.log('Sent session configuration (continuous mode):', sessionConfig);
  }

  // Send audio chunk to API
  sendAudioChunk(audioBuffer: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected, cannot send audio chunk');
      return;
    }

    // Convert Buffer to base64
    const base64Audio = audioBuffer.toString('base64');

    const message = {
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    };

    this.ws.send(JSON.stringify(message));
  }

  // Commit audio buffer to trigger transcription
  private commitAudioBuffer(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = {
      type: 'input_audio_buffer.commit',
    };

    this.ws.send(JSON.stringify(message));
    console.log('Committed audio buffer for transcription');
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'session.created':
          console.log('Session created:', message.session.id);
          this.emit('session_created', message.session);
          break;

        case 'session.updated':
          console.log('Session updated');
          break;

        case 'input_audio_buffer.committed':
          console.log('Audio buffer committed:', {
            item_id: message.item_id,
            previous_item_id: message.previous_item_id,
          });
          this.emit('audio_committed', {
            itemId: message.item_id,
            previousItemId: message.previous_item_id,
          });
          break;

        case 'input_audio_buffer.speech_started':
          console.log('Speech started');
          this.emit('speech_started');
          break;

        case 'input_audio_buffer.speech_stopped':
          console.log('Speech stopped');
          this.emit('speech_stopped');
          break;

        case 'conversation.item.created':
          console.log('Conversation item created:', message.item);
          break;

        case 'conversation.item.input_audio_transcription.completed':
          const transcription = message.transcript || '';
          console.log('Transcription completed:', transcription);

          this.emit('transcription', {
            id: message.item_id,
            text: transcription,
            timestamp: Date.now(),
            isFinal: true,
          } as TranscriptionSegment);
          break;

        case 'conversation.item.input_audio_transcription.delta':
          const delta = message.delta || '';
          console.log('Transcription delta:', delta);

          this.emit('transcription_delta', {
            id: message.item_id,
            text: delta,
            timestamp: Date.now(),
            isFinal: false,
          } as TranscriptionSegment);
          break;

        case 'error':
          console.error('API error:', message.error);
          this.emit('error', new Error(message.error.message));
          break;

        default:
          console.log('Unhandled message type:', message.type);
      }
    } catch (error) {
      console.error('Error parsing message:', error);
      this.emit('error', error);
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

      setTimeout(() => {
        this.connect().catch(console.error);
      }, 2000 * this.reconnectAttempts);
    } else {
      console.error('Max reconnection attempts reached');
      this.emit('max_reconnect_failed');
    }
  }

  disconnect(): void {
    if (this.commitInterval) {
      clearInterval(this.commitInterval);
      this.commitInterval = null;
    }
    if (this.ws) {
      this.isConnected = false;
      this.ws.close();
      this.ws = null;
      console.log('Disconnected from Realtime API');
    }
  }

  isConnectedToAPI(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }
}
