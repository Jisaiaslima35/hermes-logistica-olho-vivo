/**
 * src/modules/beep/Beep.ts — bipe audível do Olho Vivo.
 *
 * O app NÃO tem dependência nativa de áudio por padrão. O bipe é uma
 * degraded chain:
 *
 *   1. `react-native-sound` (carregado por require dinâmico protegido):
 *      toca `assets/beep.wav` (PCM mono 16-bit, 880 Hz, ~0,25 s).
 *   2. Se o módulo nativo não estiver instalado/ligado (APK antigo, sem
 *      rebuild): cai para `Vibration.vibrate([0, 120, 80, 120])`.
 *
 * NUNCA lança: o bipe é feedback, não função crítica. A falha do bipe
 * JAMAIS pode impedir a ativação da câmera nem o banner de aviso.
 */

import { Image, Vibration } from 'react-native';

// `require` local: o projeto não referencia os tipos do Node.
declare const require: (moduleId: string) => any;

const VIBRATION_PATTERN = [0, 120, 80, 120];

/**
 * Asset do bipe (WAV PCM mono 16-bit, 880 Hz, ~0,25 s).
 * O require é literal para o Metro empacotar o arquivo; o try/catch evita
 * que a ausência do asset derrube o app.
 */
let beepAsset: any = null;
let beepAssetResolved = false;

function getBeepAsset(): any {
    if (beepAssetResolved) {
        return beepAsset;
    }
    beepAssetResolved = true;

    try {
        beepAsset = require('../../assets/beep.wav');
    } catch (err) {
        console.warn('[Beep] Asset do bipe não encontrado:', err?.message);
    }

    return beepAsset;
}

type SoundInstance = {
    play?: (callback?: (success?: boolean) => void) => void;
    release?: () => void;
    setVolume?: (volume: number) => void;
};

let soundModule: any = null;
let soundModuleChecked = false;
let soundUnavailable = false;

/**
 * Carrega o `react-native-sound` de forma opcional.
 * O require é LITERAL (string fixa) para o Metro conseguir incluir o módulo
 * no bundle; o try/catch protege o app quando o lado nativo ainda não foi
 * linkado (APK sem rebuild).
 */
function loadSoundModule(): any {
    if (soundModuleChecked) {
        return soundModule;
    }
    soundModuleChecked = true;

    try {
        const mod = require('react-native-sound');
        const candidate = mod?.default ?? mod;
        if (candidate && typeof candidate === 'function') {
            soundModule = candidate;
            try {
                // iOS: categoria de playback (o app tem PTT em uso).
                soundModule.setCategory?.('Playback', true);
            } catch (err) {
                console.warn('[Beep] Não foi possível ajustar a categoria de áudio:', err?.message);
            }
        } else {
            soundUnavailable = true;
            console.warn('[Beep] react-native-sound carregou sem construtor — usando vibração.');
        }
    } catch (err) {
        soundUnavailable = true;
        console.warn('[Beep] react-native-sound indisponível (APK sem rebuild?) — usando vibração:', err?.message);
    }

    return soundModule;
}

/** true quando há um player de áudio nativo disponível. */
export function isSoundAvailable(): boolean {
    return !!loadSoundModule() && !soundUnavailable;
}

function loadAndPlay(Sound: any, filename: string, basePath?: string): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };

        try {
            const instance: SoundInstance = basePath ? new Sound(filename, basePath, onLoaded) : new Sound(filename, onLoaded);

            function onLoaded(error: any) {
                if (error) {
                    console.warn(`[Beep] Falha ao carregar "${filename}":`, error);
                    try {
                        instance?.release?.();
                    } catch (err) {
                        // ignore
                    }
                    finish(false);
                    return;
                }

                try {
                    instance.setVolume?.(1.0);
                    instance.play?.(() => {
                        try {
                            instance.release?.();
                        } catch (err) {
                            // ignore
                        }
                        finish(true);
                    });
                } catch (err) {
                    console.warn('[Beep] Falha ao tocar o bipe:', err?.message);
                    finish(false);
                }
            }
        } catch (err) {
            console.warn(`[Beep] Construtor falhou para "${filename}":`, err?.message);
            finish(false);
        }
    });
}

/** Toca o bipe com `react-native-sound` (se disponível). */
async function playWithSound(): Promise<boolean> {
    const Sound = loadSoundModule();
    if (!Sound || soundUnavailable) {
        return false;
    }

    // Estratégia 1: nome do arquivo no bundle/res (Android: res/raw/beep.wav).
    let played = await loadAndPlay(Sound, 'beep.wav');
    if (played) {
        console.log('[Beep] Bipe tocado (react-native-sound / beep.wav).');
        return true;
    }

    // Estratégia 2: URI do asset empacotado pelo Metro.
    try {
        const asset = getBeepAsset();
        const resolved = asset ? Image.resolveAssetSource(asset) : null;
        const uri = resolved?.uri;
        if (uri) {
            played = await loadAndPlay(Sound, uri);
            if (played) {
                console.log('[Beep] Bipe tocado (react-native-sound / asset uri).');
                return true;
            }
        }
    } catch (err) {
        console.warn('[Beep] Não foi possível resolver o asset do bipe:', err?.message);
    }

    return false;
}

/**
 * Toca o bipe do Olho Vivo.
 * Degrada para vibração quando não há áudio nativo. Nunca lança.
 */
export async function playBeep(): Promise<void> {
    try {
        const played = await playWithSound();
        if (played) {
            return;
        }
    } catch (err) {
        console.warn('[Beep] Falha no player de áudio, caindo para vibração:', err?.message);
    }

    try {
        Vibration.vibrate(VIBRATION_PATTERN);
        console.log('[Beep] Bipe por vibração (sem áudio nativo disponível).');
    } catch (err) {
        console.warn('[Beep] Falha também na vibração:', err?.message);
    }
}

/** Versão síncrona (não aguarda) do bipe — para chamadas em handlers. */
export function playBeepAsync(): void {
    void playBeep();
}

export const beep = {
    play: playBeep,
    playAsync: playBeepAsync,
    isSoundAvailable,
};

export default beep;
