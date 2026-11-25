import { useEffect, useState } from 'react';
import { visionController } from '../modules/vision/VisionController';

/**
 * Assina o estado da câmera Olho Vivo (VisionController).
 *
 * Retorna `true` enquanto a câmera estiver transmitindo para a Central.
 * A faixa vermelha (OlhoVivoBanner) fica presa no topo enquanto isso.
 */
export function useOlhoVivoCameraState(): boolean {
    const [isCameraActive, setIsCameraActive] = useState<boolean>(() => visionController.isCameraActive());

    useEffect(() => {
        const unsubscribe = visionController.onCameraStateChange((active: boolean) => {
            setIsCameraActive(active);
        });

        return unsubscribe;
    }, []);

    return isCameraActive;
}

export default useOlhoVivoCameraState;
