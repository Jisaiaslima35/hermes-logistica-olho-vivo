import { Room, RoomEvent, Track } from '@livekit/react-native';

export class RadioClient {
  private room: Room | null = null;
  private isTransmitting: boolean = false;
  private roomName: string = 'radio-frota-geral';

  constructor() {
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true
    });
  }

  public async connect(url: string, token: string) {
    if (!this.room) return;
    try {
      await this.room.connect(url, token);
      console.log('[RadioClient] Conectado à sala de rádio:', this.roomName);

      // Entra estritamente passivo (microfone e câmera desligados por default)
      await this.room.localParticipant.setMicrophoneEnabled(false);
      await this.room.localParticipant.setCameraEnabled(false);
    } catch (error) {
      console.error('[RadioClient] Erro ao conectar ao LiveKit:', error);
    }
  }

  public async startPtt() {
    if (this.isTransmitting || !this.room?.localParticipant) return;
    this.isTransmitting = true;
    this.playBeep('start');
    try {
      await this.room.localParticipant.setMicrophoneEnabled(true);
      console.log('[RadioClient] PTT ativo - transmitindo');
    } catch (e) {
      console.warn('[RadioClient] Erro ao abrir microfone PTT:', e);
    }
  }

  public async stopPtt() {
    if (!this.isTransmitting || !this.room?.localParticipant) return;
    this.isTransmitting = false;
    this.playBeep('stop');
    try {
      await this.room.localParticipant.setMicrophoneEnabled(false);
      console.log('[RadioClient] PTT finalizado - escuta ativa');
    } catch (e) {
      console.warn('[RadioClient] Erro ao fechar microfone PTT:', e);
    }
  }

  public getRoom(): Room | null {
    return this.room;
  }

  private playBeep(type: 'start' | 'stop') {
    // Sinalização sonora de início/fim de PTT
    console.log(`[RadioClient] PTT Audio Beep: ${type}`);
  }

  public disconnect() {
    if (this.room) {
      this.room.disconnect();
    }
  }
}

export const radioClient = new RadioClient();
export default radioClient;
