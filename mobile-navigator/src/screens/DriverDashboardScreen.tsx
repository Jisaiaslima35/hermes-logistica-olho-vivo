import { useEffect, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { Button, Text, YStack, XStack, useTheme } from 'tamagui';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faBatteryHalf, faClipboardCheck } from '@fortawesome/free-solid-svg-icons';
import { useLocation } from '../contexts/LocationContext';
import { useOrderManager } from '../contexts/OrderManagerContext';
import { humanize } from 'inflected';
import { get } from '../utils';
import OdometerNumber from '../components/OdometerNumber';
import useAppTheme from '../hooks/use-app-theme';
import { offlineLocationQueue } from '../modules/telemetry/OfflineLocationQueue';
import { offlineDvirQueue } from '../modules/dvir/OfflineDvirQueue';

const WidgetContainer = ({ px = '$4', py = '$4', children, ...props }) => {
    const { isDarkMode } = useAppTheme();
    return (
        <YStack borderRadius='$6' bg='$surface' px={px} py={py} borderWidth={1} borderColor={isDarkMode ? '$transparent' : '$gray-300'} {...props}>
            {children}
        </YStack>
    );
};

const DriverDashboardScreen = () => {
    const theme = useTheme();
    const navigation = useNavigation();
    const { isTracking, location } = useLocation();
    const { allActiveOrders } = useOrderManager();

    const [pendingPoints, setPendingPoints] = useState(0);
    const [pendingInspections, setPendingInspections] = useState(0);

    // Contadores das filas offline (telemetria e vistorias DVIR).
    useEffect(() => {
        setPendingPoints(offlineLocationQueue.size());
        setPendingInspections(offlineDvirQueue.count());

        const unsubscribePoints = offlineLocationQueue.onChange((count) => setPendingPoints(count));
        const unsubscribeInspections = offlineDvirQueue.onChange((count) => setPendingInspections(count));

        void offlineLocationQueue.load().then(() => setPendingPoints(offlineLocationQueue.size()));
        void offlineDvirQueue.load().then(() => setPendingInspections(offlineDvirQueue.count()));

        return () => {
            unsubscribePoints();
            unsubscribeInspections();
        };
    }, []);

    return (
        <YStack flex={1} bg='$background'>
            <YStack flex={1} padding='$4' gap='$4'>
                <YStack space='$4'>
                    <WidgetContainer>
                        <XStack>
                            <YStack flex={1}>
                                <Text color='$textPrimary'>Tracking:</Text>
                            </YStack>
                            <YStack flex={1} alignItems='flex-end'>
                                <Text color={isTracking ? '$successBorder' : '$textSecondary'}>{isTracking ? 'Yes' : 'No'}</Text>
                            </YStack>
                        </XStack>
                    </WidgetContainer>
                    <WidgetContainer>
                        <Text color='$textPrimary' fontWeight='bold' mb='$3'>
                            Location:
                        </Text>
                        <XStack flexWrap='wrap' gap='$3'>
                            {['latitude', 'longitude', 'heading', 'altitude'].map((key, index) => {
                                return (
                                    <YStack key={index} width='45%' overflow='hidden'>
                                        <Text color='$textSecondary'>{humanize(key)}:</Text>
                                        <Text color='$textPrimary' numberOfLines={1}>
                                            {get(location, `coords.${key}`)}
                                        </Text>
                                    </YStack>
                                );
                            })}
                        </XStack>
                    </WidgetContainer>

                    {/* Atalhos de blindagem */}
                    <WidgetContainer gap='$3'>
                        <Text color='$textPrimary' fontWeight='bold'>
                            Operação
                        </Text>
                        <XStack gap='$3' flexWrap='wrap'>
                            <Button
                                flex={1}
                                minWidth={150}
                                onPress={() => navigation.navigate('DvirInspection')}
                                bg={theme['$red-700']?.val ?? '#B91C1C'}
                                borderRadius='$4'
                                py='$3'
                            >
                                <XStack alignItems='center' gap='$2'>
                                    <FontAwesomeIcon icon={faClipboardCheck} size={14} color='#fff' />
                                    <Text color='#fff' fontSize={13} fontWeight='bold'>
                                        Vistoria do veículo (DVIR)
                                    </Text>
                                </XStack>
                            </Button>
                            <Button
                                flex={1}
                                minWidth={150}
                                onPress={() => navigation.navigate('BatteryOptimization')}
                                bg='$surface'
                                borderWidth={1}
                                borderColor='$borderColor'
                                borderRadius='$4'
                                py='$3'
                            >
                                <XStack alignItems='center' gap='$2'>
                                    <FontAwesomeIcon icon={faBatteryHalf} size={14} color={theme['$textPrimary']?.val ?? '#fff'} />
                                    <Text color='$textPrimary' fontSize={13} fontWeight='bold'>
                                        Bateria
                                    </Text>
                                </XStack>
                            </Button>
                        </XStack>
                    </WidgetContainer>

                    {/* Filas offline */}
                    <WidgetContainer gap='$2'>
                        <Text color='$textPrimary' fontWeight='bold'>
                            Filas offline
                        </Text>
                        <XStack alignItems='center' justifyContent='space-between'>
                            <Text color='$textSecondary' fontSize={12}>
                                Telemetria aguardando envio
                            </Text>
                            <Text color={pendingPoints ? '$orange-700' : '$textSecondary'} fontSize={12} fontWeight='bold'>
                                {pendingPoints} ponto(s)
                            </Text>
                        </XStack>
                        <XStack alignItems='center' justifyContent='space-between'>
                            <Text color='$textSecondary' fontSize={12}>
                                Vistorias aguardando envio
                            </Text>
                            <Text color={pendingInspections ? '$orange-700' : '$textSecondary'} fontSize={12} fontWeight='bold'>
                                {pendingInspections} vistoria(s)
                            </Text>
                        </XStack>
                    </WidgetContainer>
                </YStack>
                <XStack gap='$4'>
                    <WidgetContainer flex={1} alignItems='center' justifyContent='center'>
                        <YStack>
                            <Text color='$textPrimary' fontWeight='bold' mb='$2'>
                                Active Orders
                            </Text>
                        </YStack>
                        <YStack>
                            <OdometerNumber value={allActiveOrders.length} digitStyle={{ color: theme['$textSecondary'].val }} digitHeight={36} />
                        </YStack>
                    </WidgetContainer>
                    <WidgetContainer flex={1} alignItems='center' justifyContent='center'>
                        <YStack>
                            <Text color='$textPrimary' fontWeight='bold' mb='$2'>
                                Speed
                            </Text>
                        </YStack>
                        <YStack>
                            <OdometerNumber value={get(location, 'coords.speed', 0)} digitStyle={{ color: theme['$textSecondary'].val }} digitHeight={36} />
                        </YStack>
                    </WidgetContainer>
                </XStack>
            </YStack>
        </YStack>
    );
};

export default DriverDashboardScreen;
