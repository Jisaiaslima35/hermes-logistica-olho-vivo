import { Room, RoomEvent, CameraPosition } from '@livekit/react-native';
import { playBeep } from '../beep/Beep';
import { PANEL_ORGANIZATION_ID, panelFetch } from '../../config/panel';

// `require` local: o projeto não referencia os tipos do Node.
declare const require: (moduleId: string) => any;

export interface DataChannelMessage {
    action: 'stream_video' | 'switch_camera' | 'ptt' | 'tts' | 'ack';
    state?: boolean;
    facing?: 'front' | 'back';
    text?: string;
}

export type CameraStateListener = (active: boolean) => void;

export class VisionController {
  private room: Room | null = null;
  private cameraActive: boolean = false;
  private currentFacing: 'front' | 'back' = 'back';
  private sessionTtlTimeout: any = null;
  private cameraStateListeners: Set<CameraStateListener> = new Set();

  public attachRoom(room: Room) {
    this.room = room;
    this.setupDataChannelListener();
  }

  private setupDataChannelListener() {
    if (!this.room) return;

    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant, kind, topic) => {
      try {
        const text = new TextDecoder().decode(payload);
        const data: DataChannelMessage = JSON.parse(text);
        this.handleControlMessage(data);
      } catch (err) {
        console.warn('[VisionController] Erro ao processar mensagem DataChannel:', err);
      }
    });
  }

  private async handleControlMessage(data: DataChannelMessage) {
    console.log('[VisionController] Comando recebido:', data);

    if (data.action === 'stream_video') {
      if (data.state) {
        const facing = data.facing || 'back';
        await this.startStream(facing);
      } else {
        await this.stopStream();
      }
    } else if (data.action === 'switch_camera') {
      const facing = data.facing || (this.currentFacing === 'back' ? 'front' : 'back');
      await this.switchFacing(facing);
    }
  }

  /**
   * true enquanto a câmera Olho Vivo estiver transmitindo.
   * Usado pela faixa vermelha fixa (OlhoVivoBanner).
   */
  public isCameraActive(): boolean {
    return this.cameraActive;
  }

  /**
   * Assina as mudanças de estado da câmera.
   * Devolve a função de cancelamento (unsubscribe).
   */
  public onCameraStateChange(listener: CameraStateListener): () => void {
    this.cameraStateListeners.add(listener);

    // Estado inicial, para quem assina depois da ativação.
    try {
      listener(this.cameraActive);
    } catch (err) {
      console.warn('[VisionController] Listener de câmera falhou:', err);
    }

    return () => {
      this.cameraStateListeners.delete(listener);
    };
  }

  /** Atualiza o estado da câmera e avisa todos os assinantes. */
  private setCameraActive(active: boolean) {
    const changed = this.cameraActive !== active;
    this.cameraActive = active;

    this.cameraStateListeners.forEach((listener) => {
      try {
        listener(active);
      } catch (err) {
        console.warn('[VisionController] Listener de câmera falhou:', err);
      }
    });

    if (changed) {
      console.log(`[VisionController] Estado da câmera alterado para: ${active ? 'ATIVA' : 'INATIVA'}`);
    }
  }

  /** Ids de veículo/motorista para a auditoria do Olho Vivo no painel. */
  private getAuditContext(): { vehicleId: string | null; driverId: string | null } {
    let vehicleId: string | null = null;
    let driverId: string | null = null;

    try {
      // require dinâmico protegido: o storage é nativo (MMKV).
      const { storage } = require('../../hooks/use-storage');
      vehicleId = storage.getString('_panel_vehicle_id') || null;
      const driver = storage.getMap('driver');
      driverId = (driver && (driver as any).id) || null;
    } catch (err) {
      console.warn('[VisionController] Contexto de auditoria indisponível:', err?.message);
    }

    return { vehicleId, driverId };
  }

  /**
   * Reporta ao painel o estado REAL da câmera no aparelho.
   * Falha de rede aqui NUNCA interrompe a câmera (fire-and-forget).
   */
  private async reportCameraState(active: boolean): Promise<void> {
    try {
      const { vehicleId, driverId } = this.getAuditContext();

      await panelFetch('/api/driver/olho-vivo/camera-state', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Organization-Id': PANEL_ORGANIZATION_ID,
        },
        body: JSON.stringify({
          active,
          vehicle_id: vehicleId,
          driver_id: driverId,
          organization_id: PANEL_ORGANIZATION_ID,
        }),
      });
    } catch (err) {
      console.warn('[VisionController] Falha ao reportar estado da câmera ao painel:', err?.message);
    }
  }

  public async startStream(facing: 'front' | 'back' = 'back') {
    if (!this.room?.localParticipant) return;
    this.currentFacing = facing;
    this.cameraActive = true;

    try {
      // 480p / 15fps conforme SPEC-KIT AC-104
      await this.room.localParticipant.setCameraEnabled(true, {
        resolution: { width: 640, height: 480, frameRate: 15 },
        cameraPosition: facing === 'front' ? CameraPosition.FRONT : CameraPosition.BACK
      });
      console.log(`[VisionController] Câmera ativada: ${facing} (480p@15fps)`);

      // Faixa vermelha fixa + bipe audível: o motorista TEM que saber que
      // a câmera central está ligada. O aviso é obrigatório.
      this.setCameraActive(true);
      void playBeep();
      void this.reportCameraState(true);

      // TTL de segurança (10 minutos padrão)
      clearTimeout(this.sessionTtlTimeout);
      this.sessionTtlTimeout = setTimeout(() => {
        console.log('[VisionController] TTL da sessão de vídeo expirado');
        this.stopStream();
      }, 600000);
    } catch (e) {
      console.error('[VisionController] Falha ao ativar câmera:', e);
      this.setCameraActive(false);
    }
  }

  public async stopStream() {
    clearTimeout(this.sessionTtlTimeout);
    if (!this.room?.localParticipant) {
      this.setCameraActive(false);
      return;
    }
    this.setCameraActive(false);
    void this.reportCameraState(false);

    try {
      await this.room.localParticipant.setCameraEnabled(false);
      console.log('[VisionController] Câmera desativada');
    } catch (e) {
      console.warn('[VisionController] Erro ao desativar câmera:', e);
    }
  }

  public async switchFacing(facing: 'front' | 'back') {
    if (!this.cameraActive) return;
    this.currentFacing = facing;
    await this.startStream(facing);
  }
}

export const visionController = new VisionController();
export default visionController;
