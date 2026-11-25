import Tts from 'react-native-tts';

class TtsReader {
  private isInitialized = false;

  constructor() {
    this.init();
  }

  private init() {
    try {
      Tts.setDefaultLanguage('pt-BR');
      Tts.setDefaultRate(0.5);
      Tts.setDefaultPitch(1.0);
      this.isInitialized = true;
    } catch (e) {
      console.warn('[TtsReader] Erro ao inicializar TTS:', e);
    }
  }

  /**
   * Fala a mensagem apenas se o veículo estiver em movimento (> 5 km/h)
   * para não distrair com leituras desnecessárias quando parado ou vice-versa.
   */
  public speakIfMoving(text: string, currentSpeedKph: number) {
    if (!this.isInitialized || !text) return;
    if (currentSpeedKph > 5) {
      try {
        Tts.stop();
        Tts.speak(text);
      } catch (err) {
        console.warn('[TtsReader] Falha ao vocalizar:', err);
      }
    }
  }

  public stop() {
    try {
      Tts.stop();
    } catch (e) {}
  }
}

export const ttsReader = new TtsReader();
export default ttsReader;
