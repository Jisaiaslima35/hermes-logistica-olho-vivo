import React, { useMemo, useState } from 'react';
import { Linking, Platform, ScrollView } from 'react-native';
import { Button, Text, XStack, YStack, useTheme } from 'tamagui';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faBatteryHalf, faGear, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import DeviceInfo from 'react-native-device-info';
import BackButton from '../components/BackButton';
import { toast } from '../utils/toast';

type BatteryProfileKey = 'xiaomi' | 'samsung' | 'motorola' | 'generic';

interface BatteryProfile {
    key: BatteryProfileKey;
    title: string;
    subtitle: string;
    steps: string[];
}

const PROFILES: Record<BatteryProfileKey, BatteryProfile> = {
    xiaomi: {
        key: 'xiaomi',
        title: 'Xiaomi / Redmi / POCO (MIUI · HyperOS)',
        subtitle: 'O MIUI é o mais agressivo em matar apps em segundo plano. Faça TODOS os passos abaixo.',
        steps: [
            'Configurações → Apps → Gerenciador de apps → localize o aplicativo do Hermes → toque no nome do app.',
            'Na tela do app, ative o interruptor AUTINICIO (AutoStart). Sem isso o app não acorda com o 4G.',
            'Ainda na tela do app, entre em "Economia de energia" e DESLIGUE a economia de energia do app.',
            'Ainda na tela do app, entre em "Restrições de bateria" e escolha "Sem restrições" (ou "Nenhuma restrição").',
            'Volte para Configurações → Bateria → "Otimização de bateria" (às vezes em Configurações → Apps → apps recentes).',
            'Na lista de apps otimizados, localize o app do Hermes e troque a otimização para "Nenhuma restrição".',
            'Repita o passo 2 (Autoinício ligado) — o MIUI desliga o autoinício sozinho depois de alguns dias.',
        ],
    },
    samsung: {
        key: 'samsung',
        title: 'Samsung (One UI)',
        subtitle: 'O One UI coloca apps em "suspensão" e restringe o uso em segundo plano.',
        steps: [
            'Configurações → Bateria → Uso da bateria → "Limites de uso em segundo plano" → escolha "Nunca".',
            'Configurações → Bateria → "Apps que não podem ser colocados em suspensão" → desative "Suspender apps" para o app do Hermes (ou desative a opção geral).',
            'Configurações → Bateria → "Otimização de bateria" (Battery optimization) → localize o app do Hermes e escolha "Não otimizar" / "Desligado".',
            'Configurações → Aplicativos → Apps especiais → Acesso a dados não monitorados → ative o app do Hermes.',
            'Confirme que a bateria não está em "Economia de energia" no próprio app e que o "Always On Display" não está limitando o app.',
        ],
    },
    motorola: {
        key: 'motorola',
        title: 'Motorola',
        subtitle: 'A Motorola usa as otimizações do Android puro comsome exceções de bateria.',
        steps: [
            'Configurações → Bateria → "Otimização de bateria" → localize o app do Hermes → desative a otimização para o app.',
            'Configurações → "Apps com acesso especial" → "Acesso a dados" / "Execução automática" → permita o app do Hermes.',
            'Configurações → "Apps com acesso especial" → "Início automático" → permita o app do Hermes.',
            'Configurações → Bateria → "Restrições de bateria em segundo plano" (se existir) → marque "Ilimitado" / "Sem restrições".',
            'Se houver a opção "Economia de bateria" no menu do sistema, DESLIGUE para o app do Hermes.',
        ],
    },
    generic: {
        key: 'generic',
        title: 'Android 13 ou superior (genérico)',
        subtitle: 'Valide estas três telas do Android puro.',
        steps: [
            'Configurações → Aplicativos → nome do app (Hermes) → Bateria → escolha "Ilimitado" / "Sem restrições".',
            'Configurações → Aplicativos → nome do app → "Permissões" → "Dados móveis" → permita o uso em segundo plano.',
            'Configurações → Bateria → "Economia de bateria" → confirme que está DESLIGADA.',
            'Configurações → Aplicativos → nome do app → "Alertas" → ative os avisos (o app avisa quando a câmera Olho Vivo é ativada).',
        ],
    },
};

/** Detecta o fabricante para mostrar o caminho certo de configurações. */
export function detectBatteryProfile(): BatteryProfile {
    const brand = String(DeviceInfo.getBrand() || '').toLowerCase();
    const manufacturer = String(DeviceInfo.getManufacturer() || '').toLowerCase();
    const model = String(DeviceInfo.getModel() || '').toLowerCase();
    const haystack = `${brand} ${manufacturer} ${model}`;

    if (haystack.includes('xiaomi') || haystack.includes('redmi') || haystack.includes('poco') || haystack.includes('miui') || haystack.includes('hyperos')) {
        return PROFILES.xiaomi;
    }
    if (haystack.includes('samsung') || haystack.includes('oneui')) {
        return PROFILES.samsung;
    }
    if (haystack.includes('motorola') || haystack.includes('moto')) {
        return PROFILES.motorola;
    }
    return PROFILES.generic;
}

const BatteryOptimizationScreen = () => {
    const theme = useTheme();
    const [opening, setOpening] = useState<boolean>(false);

    const profile = useMemo(() => detectBatteryProfile(), []);

    const deviceInfo = useMemo(() => {
        try {
            return {
                brand: DeviceInfo.getBrand(),
                manufacturer: DeviceInfo.getManufacturer(),
                model: DeviceInfo.getModel(),
                system: DeviceInfo.getSystemName(),
                version: DeviceInfo.getVersion(),
            };
        } catch (err) {
            return null;
        }
    }, []);

    /**
     * Abre as configurações do Android.
     * Tenta o atalho direto para a tela de detalhes do app e cai para
     * `Linking.openSettings()` quando o atalho não existe na ROM.
     */
    const handleOpenSettings = async () => {
        setOpening(true);

        try {
            if (Platform.OS === 'android') {
                try {
                    const supported = await Linking.canOpenURL('android.settings.APPLICATION_DETAILS_SETTINGS');
                    if (supported) {
                        await Linking.openURL('android.settings.APPLICATION_DETAILS_SETTINGS');
                        return;
                    }
                } catch (err) {
                    console.warn('[BatteryOptimization] Atalho de detalhes do app indisponível:', err?.message);
                }
            }

            await Linking.openSettings();
        } catch (err) {
            console.warn('[BatteryOptimization] Falha ao abrir as configurações:', err?.message);
            toast.error('Não foi possível abrir as configurações do Android.');
        } finally {
            setOpening(false);
        }
    };

    return (
        <YStack flex={1} bg='$background'>
            <XStack alignItems='center' px='$4' py='$3' gap='$3'>
                <BackButton />
                <YStack flex={1}>
                    <Text color='$textPrimary' fontSize={18} fontWeight='bold'>
                        Otimização de Bateria
                    </Text>
                    <Text color='$textSecondary' fontSize={11}>
                        Não deixar o Android fechar o app
                    </Text>
                </YStack>
            </XStack>

            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
                <YStack
                    bg='$red-100'
                    borderWidth={1}
                    borderColor='$red-400'
                    borderRadius='$4'
                    p='$4'
                    mb='$4'
                    gap='$2'
                >
                    <XStack alignItems='center' gap='$2'>
                        <FontAwesomeIcon icon={faTriangleExclamation} size={16} color={theme['$red-700']?.val ?? '#B91C1C'} />
                        <Text color='$red-800' fontWeight='bold' fontSize={14} flex={1}>
                            O Android pode MATAR o app enquanto a tela estiver apagada
                        </Text>
                    </XStack>
                    <Text color='$red-800' fontSize={13} lineHeight={19}>
                        Durante a jornada o app precisa continuar enviando posição (telemetria), mantendo a câmera Olho Vivo auditável e a vistoria DVIR na fila offline. Se o sistema suspender o app, o
                        motorista some do painel e a Central perde a visão da operação.{'\n\n'}
                        Durante o trajeto, deixe a TELA LIGADA (ou ative "tela sempre ativa" nas configurações do aparelho). As instruções abaixo liberam o app para rodar em segundo plano.
                    </Text>
                </YStack>

                <YStack bg='$surface' borderWidth={1} borderColor='$borderColor' borderRadius='$4' p='$4' mb='$4' gap='$2'>
                    <Text color='$textPrimary' fontWeight='bold' fontSize={15}>
                        {profile.title}
                    </Text>
                    <Text color='$textSecondary' fontSize={13} lineHeight={19}>
                        {profile.subtitle}
                    </Text>
                    {deviceInfo ? (
                        <Text color='$textSecondary' fontSize={11} marginTop='$2'>
                            Aparelho detectado: {deviceInfo.brand} {deviceInfo.manufacturer} {deviceInfo.model} · {deviceInfo.system} {deviceInfo.version}
                        </Text>
                    ) : null}
                </YStack>

                <YStack bg='$surface' borderWidth={1} borderColor='$borderColor' borderRadius='$4' p='$4' mb='$4' gap='$3'>
                    <Text color='$textPrimary' fontWeight='bold' fontSize={15}>
                        Passo a passo
                    </Text>
                    {profile.steps.map((step, index) => (
                        <XStack key={`step-${index}`} gap='$3' alignItems='flex-start'>
                            <YStack
                                width={26}
                                height={26}
                                borderRadius={13}
                                bg='$primary'
                                alignItems='center'
                                justifyContent='center'
                                marginTop={2}
                            >
                                <Text color='$textPrimary' fontSize={13} fontWeight='bold'>
                                    {index + 1}
                                </Text>
                            </YStack>
                            <Text color='$textPrimary' fontSize={13} lineHeight={20} flex={1}>
                                {step}
                            </Text>
                        </XStack>
                    ))}
                </YStack>

                <Button onPress={handleOpenSettings} disabled={opening} bg='$primary' borderRadius='$4' py='$3'>
                    <XStack alignItems='center' gap='$2'>
                        <FontAwesomeIcon icon={faGear} size={16} color={theme['$textPrimary']?.val ?? '#fff'} />
                        <Button.Text fontSize={15} fontWeight='bold'>
                            ABRIR CONFIGURAÇÕES DO ANDROID
                        </Button.Text>
                    </XStack>
                </Button>

                <YStack alignItems='center' gap='$2' mt='$5'>
                    <FontAwesomeIcon icon={faBatteryHalf} size={18} color={theme['$textSecondary']?.val ?? '#666'} />
                    <Text color='$textSecondary' fontSize={11} textAlign='center'>
                        Depois de liberar o app, force o encerramento uma vez e reabra o aplicativo: assim o sistema refaz a lista de apps otimizados.
                    </Text>
                </YStack>
            </ScrollView>
        </YStack>
    );
};

export default BatteryOptimizationScreen;
