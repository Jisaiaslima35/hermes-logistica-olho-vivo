import React from 'react';
import { View } from 'react-native';
import { Text, YStack } from 'tamagui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import useOlhoVivoCameraState from '../hooks/use-olho-vivo-camera-state';

/**
 * OlhoVivoBanner — faixa vermelha FIXA no topo enquanto a câmera Olho Vivo
 * estiver ativa.
 *
 * REGRAS (blindagem, não negociáveis):
 *  - Não TEM botão de fechar.
 *  - Não TEM estado de "dispensado".
 *  - Não TEM gesto para dispensar.
 *  - `pointerEvents="none"` no container para não bloquear a UI.
 *  - Respeita a área de status bar (safe area).
 *
 * O texto é EXATO e não pode ser alterado.
 */
export const OLHO_VIVO_BANNER_TEXT = 'CÂMERA OLHO VIVO ATIVA — TRANSMITINDO PARA A CENTRAL';

const OlhoVivoBanner = () => {
    const insets = useSafeAreaInsets();
    const isCameraActive = useOlhoVivoCameraState();

    if (!isCameraActive) {
        return null;
    }

    return (
        <View
            pointerEvents='none'
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 9999,
                elevation: 9999,
            }}
        >
            <YStack
                width='100%'
                backgroundColor='#C62828'
                paddingTop={insets.top + 6}
                paddingBottom={8}
                paddingHorizontal={12}
                alignItems='center'
                justifyContent='center'
            >
                <Text
                    color='#FFFFFF'
                    fontWeight='bold'
                    fontSize={12}
                    lineHeight={16}
                    textAlign='center'
                >
                    {OLHO_VIVO_BANNER_TEXT}
                </Text>
            </YStack>
        </View>
    );
};

export default OlhoVivoBanner;
