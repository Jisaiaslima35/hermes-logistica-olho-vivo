import React, { createContext, useState, useEffect, useCallback, useContext, useMemo, useRef } from 'react';
import { Platform, PermissionsAndroid, AppState } from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import { Place, Point } from '@fleetbase/sdk';
import { useAuth } from './AuthContext';
import useStorage from '../hooks/use-storage';
import useFleetbase from '../hooks/use-fleetbase';
import { ttsReader } from '../modules/tts/TtsReader';
import { offlineLocationQueue } from '../modules/telemetry/OfflineLocationQueue';
import DeviceInfo from 'react-native-device-info';

/** Cache do nível de bateria (leitura nativa é cara — 1x por minuto). */
let cachedBatteryPct: number | null = null;
let cachedBatteryAt = 0;

const readBatteryPct = async (): Promise<number | null> => {
    const now = Date.now();
    if (cachedBatteryPct !== null && now - cachedBatteryAt < 60000) {
        return cachedBatteryPct;
    }

    try {
        const level = await DeviceInfo.getBatteryLevel();
        cachedBatteryPct = typeof level === 'number' && Number.isFinite(level) ? Math.round(level * 100) : null;
        cachedBatteryAt = now;
    } catch (err) {
        cachedBatteryPct = null;
    }

    return cachedBatteryPct;
};

const LocationContext = createContext({
    location: null,
    isTracking: false,
    startTracking: () => {},
    stopTracking: () => {},
    getDriverLocationAsPlace: (attrs?: any) => null,
    trackLocation: () => Promise.resolve(),
});

export const LocationProvider = ({ children }) => {
    const { isOnline, driver, trackDriver } = useAuth();
    const { adapter } = useFleetbase();
    const [authToken] = useStorage('_driver_token');
    const [location, setLocation] = useStorage(`${driver?.id ?? 'anon'}_location`, {});
    const [isTracking, setIsTracking] = useState(false);
    const watchId = useRef<number | null>(null);
    const lastMovementTime = useRef<number>(Date.now());
    const isStationary = useRef<boolean>(false);

    // Solicita permissão de geolocalização com Foreground Service no Android
    const requestLocationPermission = async () => {
        if (Platform.OS === 'ios') {
            const auth = await Geolocation.requestAuthorization('always');
            return auth === 'granted';
        }

        if (Platform.OS === 'android') {
            const granted = await PermissionsAndroid.requestMultiple([
                PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
                PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
                ...(Platform.Version >= 29 ? [PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION] : [])
            ]);

            return (
                granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED ||
                granted[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED
            );
        }

        return true;
    };

    // Callback para processamento da nova posição
    const handlePositionUpdate = useCallback((pos) => {
        const { latitude, longitude, speed, heading, accuracy, altitude } = pos.coords;
        const speedKph = speed ? Math.max(0, speed * 3.6) : 0;
        const now = Date.now();

        // Detecção de movimento vs parada (> 5 min sem movimento)
        if (speedKph > 3) {
            lastMovementTime.current = now;
            if (isStationary.current) {
                isStationary.current = false;
                ttsReader.speakIfMoving('Veículo em trânsito. Telemetria ativa.', speedKph);
            }
        } else {
            if (now - lastMovementTime.current > 300000) {
                // Parado há mais de 5 minutos - suspende envio contínuo para economizar bateria
                isStationary.current = true;
            }
        }

        const newLoc = {
            coords: {
                latitude,
                longitude,
                speed: speedKph,
                heading: heading || 0,
                accuracy: accuracy || 0,
                altitude: altitude || 0
            },
            timestamp: pos.timestamp
        };

        setLocation(newLoc);
        if (trackDriver && !isStationary.current) {
            trackDriver(newLoc.coords);
        }

        // Fila offline de telemetria (store-and-forward para o painel).
        // O timestamp é o ORIGINAL do dispositivo — nunca o momento do flush.
        const recordedAt = typeof pos.timestamp === 'number' && Number.isFinite(pos.timestamp) ? new Date(pos.timestamp).toISOString() : new Date(now).toISOString();
        void readBatteryPct().then((batteryPct) => {
            void offlineLocationQueue.enqueue({
                lat: latitude,
                lon: longitude,
                speed_kph: speedKph,
                heading_deg: heading || 0,
                battery_pct: batteryPct,
                deviation_m: null,
                stopped_s: isStationary.current ? Math.round((now - lastMovementTime.current) / 1000) : 0,
                recorded_at: recordedAt,
            });
        });
    }, [setLocation, trackDriver]);

    // Iniciar rastreamento contínuo
    const startTracking = useCallback(async () => {
        const hasPermission = await requestLocationPermission();
        if (!hasPermission) {
            console.warn('[LocationContext] Permissão de localização negada');
            return;
        }

        if (watchId.current !== null) return;

        setIsTracking(true);
        watchId.current = Geolocation.watchPosition(
            handlePositionUpdate,
            (error) => {
                console.warn('[LocationContext] Geolocation error:', error.code, error.message);
            },
            {
                enableHighAccuracy: true,
                distanceFilter: 10,
                interval: 30000,          // 30 s em movimento
                fastestInterval: 15000,
                showsBackgroundLocationIndicator: true,
                forceRequestLocation: true
            }
        );

        console.log('[LocationContext] Foreground tracking iniciado');
    }, [handlePositionUpdate]);

    // Parar rastreamento
    const stopTracking = useCallback(() => {
        if (watchId.current !== null) {
            Geolocation.clearWatch(watchId.current);
            watchId.current = null;
        }
        setIsTracking(false);
        console.log('[LocationContext] Tracking finalizado');
    }, []);

    // Obter posição única
    const trackLocation = useCallback(async () => {
        const hasPermission = await requestLocationPermission();
        if (!hasPermission) return;

        Geolocation.getCurrentPosition(
            (pos) => handlePositionUpdate(pos),
            (err) => console.warn('[LocationContext] getCurrentPosition error:', err),
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
        );
    }, [handlePositionUpdate]);

    // Driver location como Place SDK
    const getDriverLocationAsPlace = useCallback(
        (attributes = {}) => {
            const coords = location?.coords;
            if (!coords) return null;

            return new Place(
                {
                    id: 'driver',
                    name: 'Driver Location',
                    street1: 'Driver Location',
                    location: new Point(coords.latitude, coords.longitude),
                    ...attributes,
                },
                adapter
            );
        },
        [location, adapter]
    );

    useEffect(() => {
        if (isOnline && driver) {
            startTracking();
        } else {
            stopTracking();
        }

        return () => {
            stopTracking();
        };
    }, [isOnline, driver?.id, startTracking, stopTracking]);

    // Fila offline de telemetria: carrega do storage e envia a cada 60 s.
    useEffect(() => {
        void offlineLocationQueue.load();
        offlineLocationQueue.startAutoFlush(60000);

        return () => {
            offlineLocationQueue.stopAutoFlush();
        };
    }, []);

    const value = useMemo(
        () => ({ location, isTracking, startTracking, stopTracking, getDriverLocationAsPlace, trackLocation }),
        [location, isTracking, startTracking, stopTracking, getDriverLocationAsPlace, trackLocation]
    );

    return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
};

export const useLocation = () => {
    const context = useContext(LocationContext);
    if (context === undefined) {
        throw new Error('useLocation must be used within a LocationProvider');
    }
    return context;
};
