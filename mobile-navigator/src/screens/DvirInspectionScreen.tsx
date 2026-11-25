import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Input, Text, XStack, YStack, useTheme } from 'tamagui';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faCamera, faCheck, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import type { Camera as CameraRef } from 'react-native-vision-camera';
import ImageResizer from '@bam.tech/react-native-image-resizer';
import RNFS from 'react-native-fs';
import Geolocation from 'react-native-geolocation-service';
import BackButton from '../components/BackButton';
import { PANEL_ORGANIZATION_ID, getPanelVehicleId, setPanelVehicleId, panelFetch, readPanelError } from '../config/panel';
import { offlineDvirQueue, generateClientId } from '../modules/dvir/OfflineDvirQueue';
import { useLocation } from '../contexts/LocationContext';
import { storage } from '../hooks/use-storage';
import { toast } from '../utils/toast';

/**
 * src/screens/DvirInspectionScreen.tsx
 *
 * Vistoria fotográfica obrigatória (DVIR) — entrada e saída do turno.
 *
 * ── GALERIA TRAVADA (requisito crítico) ────────────────────────────────────
 * A captura deste fluxo ABRE EXCLUSIVAMENTE a câmera nativa
 * (`react-native-vision-camera`). NÃO existe — e NÃO pode existir — caminho
 * de galeria neste arquivo:
 *   - `launchImageLibrary` (react-native-image-picker) NÃO é importado aqui;
 *   - o componente `CameraCapture.tsx` (que tem botão de galeria) NÃO é
 *     reutilizado neste fluxo;
 *   - a única forma de anexar uma foto é o botão de captura, que chama
 *     `cameraRef.current.takePhoto()`.
 *
 * ── Contrato com o painel ──────────────────────────────────────────────────
 * GET  {PANEL_BASE_URL}/api/dvir/templates
 * POST {PANEL_BASE_URL}/api/driver/dvir   (multipart/form-data)
 */

interface DvirTemplate {
    id: string;
    vehicle_category: string;
    label: string;
    required_items: string[];
    required_photos: string[];
}

interface CapturedPhoto {
    uri: string;
    size: number;
}

type ShiftType = 'entrada' | 'saida';
type ChecklistValue = 'ok' | 'not_ok';

/** Slots aceitos pelo servidor (o nome do campo no multipart = slot). */
const PHOTO_SLOTS: string[] = ['frente', 'lateral_esquerda', 'lateral_direita', 'pneus', 'velocimetro', 'avaria'];

/** Rótulos amigáveis dos slots. */
const SLOT_LABELS: Record<string, string> = {
    frente: 'Frente',
    lateral_esquerda: 'Lateral esquerda',
    lateral_direita: 'Lateral direita',
    pneus: 'Pneus',
    velocimetro: 'Velocímetro',
    avaria: 'Avaria',
};

/** Categorias de veículo (o banco usa 'bau'; o app também aceita 'caminhao_bau'). */
const VEHICLE_CATEGORIES = [
    { key: 'moto', label: 'Moto' },
    { key: 'utilitario', label: 'Utilitário' },
    { key: 'bau', label: 'Caminhão Baú' },
    { key: 'carreta', label: 'Carreta' },
];

const MAX_ACCEPTED_PHOTO_BYTES = 400 * 1024;
const LAST_ENTRANCE_KEY = '_dvir_last_entrance_id';

function normalizeCategory(category: string): string {
    const value = String(category || '').toLowerCase();
    if (value === 'caminhao_bau' || value === 'caminhao' || value === 'baú' || value === 'bau') {
        return 'bau';
    }
    return value;
}

function prettify(value: string): string {
    const text = String(value || '').replace(/_/g, ' ').trim();
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function readStoredValue(key: string): string | null {
    try {
        return storage.getString(key) || null;
    } catch (err) {
        return null;
    }
}

function writeStoredValue(key: string, value: string | null): void {
    try {
        if (value) {
            storage.setString(key, value);
        } else {
            storage.removeItem(key);
        }
    } catch (err) {
        console.warn('[DvirInspection] Não foi possível gravar a preference:', err?.message);
    }
}

function readDriverId(): string {
    try {
        const driver = storage.getMap('driver');
        const id = (driver as any)?.id;
        return id ? String(id) : '';
    } catch (err) {
        return '';
    }
}

/**
 * Câmera EXCLUSIVA (sem galeria).
 * Componente interno do fluxo DVIR — não reaproveita `CameraCapture.tsx`
 * porque aquele componente oferece a opção de escolher da galeria.
 */
const DvirCamera = ({ visible, slotLabel, onCancel, onCaptured }: { visible: boolean; slotLabel: string; onCancel: () => void; onCaptured: (photo: CapturedPhoto) => void }) => {
    const cameraRef = useRef<CameraRef>(null);
    const device = useCameraDevice('back');
    const [hasPermission, setHasPermission] = useState<boolean>(false);
    const [capturing, setCapturing] = useState<boolean>(false);

    useEffect(() => {
        if (!visible) {
            return;
        }

        (async () => {
            try {
                const status = await Camera.getCameraPermissionStatus();
                if (status !== 'granted') {
                    const requested = await Camera.requestCameraPermission();
                    setHasPermission(requested === 'granted');
                } else {
                    setHasPermission(true);
                }
            } catch (err) {
                console.warn('[DvirInspection] Permissão de câmera:', err?.message);
                setHasPermission(false);
            }
        })();
    }, [visible]);

    const handleTakePhoto = useCallback(async () => {
        if (!cameraRef.current || capturing) {
            return;
        }

        setCapturing(true);

        try {
            // SOMENTE a câmera nativa — nenhum caminho de galeria aqui.
            const photo = await cameraRef.current.takePhoto({
                flash: 'off',
                qualityPrioritization: 'balanced',
            });

            const rawUri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;

            // Compressão para JPEG leve (~200 KB).
            let resized = await ImageResizer.createResizedImage(rawUri, 1280, 960, 'JPEG', 80, 0, undefined, false, { mode: 'contain', onlyScaleDown: true });
            let size = Number(resized?.size ?? 0);

            if (!size) {
                try {
                    const stat = await RNFS.stat(stripFileScheme(resized.uri));
                    size = Number(stat?.size ?? 0);
                } catch (err) {
                    size = 0;
                }
            }

            if (size > MAX_ACCEPTED_PHOTO_BYTES) {
                console.log(`[DvirInspection] Foto com ${Math.round(size / 1024)} KB — recomprimindo com qualidade menor.`);
                resized = await ImageResizer.createResizedImage(rawUri, 1024, 768, 'JPEG', 55, 0, undefined, false, { mode: 'contain', onlyScaleDown: true });
                size = Number(resized?.size ?? 0);
            }

            onCaptured({ uri: resized.uri, size });
        } catch (err) {
            console.warn('[DvirInspection] Falha na captura:', err?.message);
            toast.error('Não foi possível capturar a foto.');
        } finally {
            setCapturing(false);
        }
    }, [capturing, onCaptured]);

    if (!visible) {
        return null;
    }

    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000', zIndex: 9998 }}>
            {device && hasPermission ? (
                <Camera ref={cameraRef} style={{ flex: 1 }} device={device} isActive={true} photo={true} />
            ) : (
                <YStack flex={1} alignItems='center' justifyContent='center' gap='$3'>
                    <Text color='#fff'>Abrindo a câmera…</Text>
                    {!hasPermission ? <Text color='#fca5a5' fontSize={12}>Permissão de câmera negada</Text> : null}
                </YStack>
            )}

            <YStack position='absolute' top={0} left={0} right={0} p='$4'>
                <XStack alignItems='center' justifyContent='space-between'>
                    <XStack alignItems='center' gap='$2'>
                        <FontAwesomeIcon icon={faCamera} size={16} color='#fff' />
                        <Text color='#fff' fontWeight='bold'>
                            {slotLabel}
                        </Text>
                    </XStack>
                    <Button onPress={onCancel} bg='rgba(0,0,0,0.5)' circular size={34}>
                        <Button.Icon>
                            <FontAwesomeIcon icon={faXmark} size={14} color='#fff' />
                        </Button.Icon>
                    </Button>
                </XStack>
            </YStack>

            <YStack position='absolute' bottom={0} left={0} right={0} p='$5' alignItems='center'>
                <Text color='#fff' fontSize={11} mb='$2' textAlign='center'>
                    Galeria bloqueada — apenas câmera
                </Text>
                <Button onPress={handleTakePhoto} disabled={capturing} size={72} circular bg='#C62828' borderWidth={4} borderColor='#fff'>
                    <Button.Icon>
                        <FontAwesomeIcon icon={faCamera} size={26} color='#fff' />
                    </Button.Icon>
                </Button>
            </YStack>
        </View>
    );
};

function stripFileScheme(uri: string): string {
    return String(uri || '').replace(/^file:\/\//, '');
}

const DvirInspectionScreen = () => {
    const theme = useTheme();
    const { location } = useLocation();

    const [templates, setTemplates] = useState<DvirTemplate[]>([]);
    const [loadingTemplates, setLoadingTemplates] = useState<boolean>(true);
    const [templateError, setTemplateError] = useState<string | null>(null);

    const [category, setCategory] = useState<string>(VEHICLE_CATEGORIES[0].key);
    const [shiftType, setShiftType] = useState<ShiftType>('entrada');
    const [vehicleId, setVehicleId] = useState<string>('');
    const [odometer, setOdometer] = useState<string>('');
    const [driverId, setDriverId] = useState<string>('');

    const [checklist, setChecklist] = useState<Record<string, ChecklistValue>>({});
    const [photos, setPhotos] = useState<Record<string, CapturedPhoto>>({});
    const [hasDamage, setHasDamage] = useState<boolean>(false);
    const [damageNotes, setDamageNotes] = useState<string>('');

    const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
    const [gpsLoading, setGpsLoading] = useState<boolean>(false);

    const [cameraSlot, setCameraSlot] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState<boolean>(false);
    const [resultMessage, setResultMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const [queueCount, setQueueCount] = useState<number>(0);

    // ── carga inicial ───────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;

        (async () => {
            setLoadingTemplates(true);
            setTemplateError(null);

            try {
                const response = await panelFetch('/api/dvir/templates', { method: 'GET' });

                if (!response.ok) {
                    const error = await readPanelError(response, `Falha ao carregar os checklists (HTTP ${response.status}).`);
                    if (!cancelled) {
                        setTemplateError(error);
                    }
                    return;
                }

                const body = await response.json();
                const list: DvirTemplate[] = Array.isArray(body) ? body : [];

                if (!cancelled) {
                    setTemplates(list);
                }
            } catch (err) {
                console.warn('[DvirInspection] Falha ao carregar os templates:', err?.message);
                if (!cancelled) {
                    setTemplateError('Sem conexão com a Central. Os checklists serão carregados quando houver rede.');
                }
            } finally {
                if (!cancelled) {
                    setLoadingTemplates(false);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const storedVehicle = getPanelVehicleId();
        if (storedVehicle) {
            setVehicleId(storedVehicle);
        }
        setDriverId(readDriverId());
        setQueueCount(offlineDvirQueue.count());

        // O auto-flush da fila é global (tá no DriverLayout) — aqui só
        // assina a contagem para a UI.
        const unsubscribe = offlineDvirQueue.onChange((count: number) => setQueueCount(count));
        void offlineDvirQueue.load().then(() => setQueueCount(offlineDvirQueue.count()));

        return () => {
            unsubscribe();
        };
    }, []);

    const template = useMemo(() => {
        return templates.find((item) => normalizeCategory(item.vehicle_category) === category) ?? null;
    }, [templates, category]);

    const requiredItems = useMemo<string[]>(() => {
        if (template?.required_items && Array.isArray(template.required_items)) {
            return template.required_items;
        }
        return [];
    }, [template]);

    const requiredPhotos = useMemo<string[]>(() => {
        const fromTemplate = template?.required_photos && Array.isArray(template.required_photos) ? template.required_photos : [];
        const slots = fromTemplate.filter((slot) => PHOTO_SLOTS.includes(slot));
        return slots.length ? slots : PHOTO_SLOTS.filter((slot) => slot !== 'avaria');
    }, [template]);

    const visibleSlots = useMemo<string[]>(() => {
        const slots = [...requiredPhotos];
        if (hasDamage && !slots.includes('avaria')) {
            slots.push('avaria');
        }
        return slots;
    }, [requiredPhotos, hasDamage]);

    const checklistComplete = requiredItems.every((item) => !!checklist[item]);
    const photosCount = Object.keys(photos).length;

    // ── GPS ─────────────────────────────────────────────────────────────────
    const captureGps = useCallback(async (): Promise<{ lat: number; lng: number } | null> => {
        setGpsLoading(true);

        try {
            const position = await new Promise<any>((resolve, reject) => {
                Geolocation.getCurrentPosition(
                    (pos: any) => resolve(pos),
                    (err: any) => reject(err),
                    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
                );
            });

            const coords = { lat: Number(position?.coords?.latitude), lng: Number(position?.coords?.longitude) };
            setGps(coords);
            setGpsLoading(false);
            return coords;
        } catch (err) {
            console.warn('[DvirInspection] GPS indisponível:', err?.message);

            // Fallback: última posição conhecida do app.
            const fallback = location?.coords;
            if (fallback && Number.isFinite(Number(fallback.latitude)) && Number.isFinite(Number(fallback.longitude))) {
                const coords = { lat: Number(fallback.latitude), lng: Number(fallback.longitude) };
                setGps(coords);
                setGpsLoading(false);
                return coords;
            }

            setGpsLoading(false);
            return null;
        }
    }, [location]);

    // ── checklist ──────────────────────────────────────────────────────────
    const toggleChecklistItem = useCallback((item: string, value: ChecklistValue) => {
        setChecklist((prev) => {
            const next = { ...prev };

            if (next[item] === value) {
                delete next[item];
            } else {
                next[item] = value;
            }

            return next;
        });
    }, []);

    // ── envio ──────────────────────────────────────────────────────────────
    const handleSubmit = useCallback(async () => {
        if (!vehicleId.trim()) {
            toast.error('Informe o ID do veículo.');
            return;
        }
        if (!photosCount) {
            toast.error('É obrigatória ao menos uma foto na vistoria.');
            return;
        }
        if (requiredItems.length && !checklistComplete) {
            toast.error('Marque todos os itens do checklist.');
            return;
        }
        if (hasDamage && !damageNotes.trim()) {
            toast.error('Com avaria, o campo "descrição da avaria" é obrigatório.');
            return;
        }

        setSubmitting(true);
        setResultMessage(null);

        const position = gps ?? (await captureGps());
        const clientId = generateClientId();

        const fields: Record<string, any> = {
            vehicle_id: vehicleId.trim(),
            driver_id: driverId || null,
            shift_type: shiftType,
            checklist: JSON.stringify(checklist),
            has_damage: hasDamage ? '1' : '0',
            damage_notes: damageNotes.trim(),
            odometer_km: odometer.trim() ? odometer.trim() : null,
            gps_lat: position ? position.lat : null,
            gps_lng: position ? position.lng : null,
            organization_id: PANEL_ORGANIZATION_ID,
            client_id: clientId,
        };

        const pairedId = readStoredValue(LAST_ENTRANCE_KEY);
        if (pairedId) {
            fields.paired_inspection_id = pairedId;
        }

        const photosPayload = Object.keys(photos).map((slot) => ({ slot, uri: photos[slot].uri, size: photos[slot].size }));

        try {
            const form = new FormData();

            Object.keys(fields).forEach((key) => {
                const value = fields[key];
                if (value === undefined || value === null) return;
                form.append(key, typeof value === 'string' ? value : String(value));
            });

            photosPayload.forEach((photo) => {
                form.append(photo.slot, {
                    uri: photo.uri,
                    type: 'image/jpeg',
                    name: `${photo.slot}.jpg`,
                } as any);
            });

            const response = await panelFetch('/api/driver/dvir', {
                method: 'POST',
                body: form as any,
            });

            if (!response.ok) {
                const error = await readPanelError(response, `Falha ao enviar a vistoria (HTTP ${response.status}).`);
                setResultMessage({ ok: false, text: error });

                // Sem rede (fetch rejeitado) OU erro de servidor?
                // 4xx (400/413) é erro do conteúdo — a fila offline não ajuda.
                // Erro de rede/servidor → guarda localmente para reenviar.
                if (response.status >= 500 || response.status === 408 || response.status === 429) {
                    await offlineDvirQueue.enqueue({ client_id: clientId, fields, photos: photosPayload });
                    setQueueCount(offlineDvirQueue.count());
                    setResultMessage({ ok: false, text: `${error}\n\nVistoria guardada na fila offline — será reenviada automaticamente.` });
                }
                return;
            }

            let inspectionId = '';
            try {
                const body = await response.json();
                inspectionId = body?.id ? String(body.id) : '';
            } catch (err) {
                // resposta sem corpo — segue com o que temos
            }

            if (shiftType === 'entrada' && inspectionId) {
                writeStoredValue(LAST_ENTRANCE_KEY, inspectionId);
            }
            if (shiftType === 'saida') {
                writeStoredValue(LAST_ENTRANCE_KEY, null);
            }

            // Guarda o veículo no storage local — a telemetria usa o mesmo id.
            setPanelVehicleId(vehicleId.trim());

            setResultMessage({ ok: true, text: `Vistoria enviada com sucesso${inspectionId ? ` — id ${inspectionId}` : ''}.` });
            toast.success('Vistoria enviada.');

            // limpa o formulário
            setChecklist({});
            setPhotos({});
            setOdometer('');
            setDamageNotes('');
            setHasDamage(false);
        } catch (err) {
            // Sem rede → fila offline.
            await offlineDvirQueue.enqueue({ client_id: clientId, fields, photos: photosPayload });
            setQueueCount(offlineDvirQueue.count());
            setResultMessage({ ok: false, text: `Sem conexão com a Central. Vistoria guardada na fila offline (${offlineDvirQueue.count()} aguardando envio).` });
        } finally {
            setSubmitting(false);
        }
    }, [vehicleId, photosCount, requiredItems.length, checklistComplete, hasDamage, damageNotes, shiftType, gps, captureGps, checklist, driverId, odometer, photos]);

    const handleCaptured = useCallback(
        (slot: string) => (photo: CapturedPhoto) => {
            setPhotos((prev) => ({ ...prev, [slot]: photo }));
            setCameraSlot(null);

            // GPS junto com a foto (a posição no momento da captura).
            void captureGps();

            toast.success(`${SLOT_LABELS[slot] || slot} capturada (${Math.round(photo.size / 1024)} KB).`);
        },
        [captureGps]
    );

    return (
        <YStack flex={1} bg='$background'>
            <XStack alignItems='center' px='$4' py='$3' gap='$3'>
                <BackButton />
                <YStack flex={1}>
                    <Text color='$textPrimary' fontSize={18} fontWeight='bold'>
                        Vistoria do veículo (DVIR)
                    </Text>
                    <Text color='$textSecondary' fontSize={11}>
                        {shiftType === 'entrada' ? 'Início do turno' : 'Fim do turno'} · {photosCount} foto(s)
                    </Text>
                </YStack>
            </XStack>

            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
                {/* GALERIA BLOQUEADA */}
                <YStack bg='$red-100' borderWidth={1} borderColor='$red-400' borderRadius='$4' p='$3' mb='$4'>
                    <XStack alignItems='center' gap='$2'>
                        <FontAwesomeIcon icon={faTriangleExclamation} size={14} color={theme['$red-700']?.val ?? '#B91C1C'} />
                        <Text color='$red-800' fontWeight='bold' fontSize={13} flex={1}>
                            Galeria bloqueada — apenas câmera
                        </Text>
                    </XStack>
                    <Text color='$red-800' fontSize={12} lineHeight={17} mt='$1'>
                        As fotos desta vistoria são feitas NA HORA, pela câmera do aparelho. Não é possível enviar foto da galeria.
                    </Text>
                </YStack>

                {/* Modo */}
                <Text color='$textPrimary' fontWeight='bold' fontSize={13} mb='$2'>
                    Tipo de vistoria
                </Text>
                <XStack gap='$2' mb='$4'>
                    <Button flex={1} onPress={() => setShiftType('entrada')} bg={shiftType === 'entrada' ? '$primary' : '$surface'} borderWidth={1} borderColor='$borderColor'>
                        <Button.Text fontSize={13}>Entrada</Button.Text>
                    </Button>
                    <Button flex={1} onPress={() => setShiftType('saida')} bg={shiftType === 'saida' ? '$primary' : '$surface'} borderWidth={1} borderColor='$borderColor'>
                        <Button.Text fontSize={13}>Saída</Button.Text>
                    </Button>
                </XStack>

                {/* Tipo de veículo */}
                <Text color='$textPrimary' fontWeight='bold' fontSize={13} mb='$2'>
                    Tipo de veículo
                </Text>
                <XStack gap='$2' flexWrap='wrap' mb='$4'>
                    {VEHICLE_CATEGORIES.map((item) => (
                        <Button key={item.key} onPress={() => setCategory(item.key)} bg={category === item.key ? '$primary' : '$surface'} borderWidth={1} borderColor='$borderColor' size='$3'>
                            <Button.Text fontSize={12}>{item.label}</Button.Text>
                        </Button>
                    ))}
                </XStack>
                {loadingTemplates ? <Text color='$textSecondary' fontSize={12} mb='$3'>Carregando checklists…</Text> : null}
                {templateError ? (
                    <Text color='$red-700' fontSize={12} mb='$3'>
                        {templateError}
                    </Text>
                ) : null}
                {template ? (
                    <Text color='$textSecondary' fontSize={12} mb='$3'>
                        Checklist: {template.label}
                    </Text>
                ) : null}

                {/* Identificação */}
                <YStack gap='$3' mb='$4'>
                    <YStack gap='$1'>
                        <Text color='$textSecondary' fontSize={11}>
                            ID do veículo (obrigatório)
                        </Text>
                        <Input value={vehicleId} onChangeText={setVehicleId} placeholder='Ex.: VH-001' bg='$surface' borderWidth={1} borderColor='$borderColor' />
                    </YStack>
                    <YStack gap='$1'>
                        <Text color='$textSecondary' fontSize={11}>
                            Odômetro (km)
                        </Text>
                        <Input value={odometer} onChangeText={setOdometer} keyboardType='numeric' placeholder='Ex.: 128430' bg='$surface' borderWidth={1} borderColor='$borderColor' />
                    </YStack>
                </YStack>

                {/* Checklist */}
                {requiredItems.length ? (
                    <YStack mb='$4' gap='$2'>
                        <Text color='$textPrimary' fontWeight='bold' fontSize={13}>
                            Checklist ({Object.keys(checklist).filter((key) => checklist[key]).length}/{requiredItems.length})
                        </Text>
                        {requiredItems.map((item) => (
                            <XStack key={item} alignItems='center' justifyContent='space-between' bg='$surface' borderWidth={1} borderColor='$borderColor' borderRadius='$3' px='$3' py='$2'>
                                <Text color='$textPrimary' fontSize={13} flex={1}>
                                    {prettify(item)}
                                </Text>
                                <XStack gap='$2'>
                                    <Button size='$3' onPress={() => toggleChecklistItem(item, 'ok')} bg={checklist[item] === 'ok' ? '$green-600' : '$surface'} borderWidth={1} borderColor='$borderColor'>
                                        <Button.Icon>
                                            <FontAwesomeIcon icon={faCheck} size={12} color={checklist[item] === 'ok' ? '#fff' : theme['$textSecondary']?.val ?? '#666'} />
                                        </Button.Icon>
                                    </Button>
                                    <Button size='$3' onPress={() => toggleChecklistItem(item, 'not_ok')} bg={checklist[item] === 'not_ok' ? '#C62828' : '$surface'} borderWidth={1} borderColor='$borderColor'>
                                        <Button.Icon>
                                            <FontAwesomeIcon icon={faXmark} size={12} color={checklist[item] === 'not_ok' ? '#fff' : theme['$textSecondary']?.val ?? '#666'} />
                                        </Button.Icon>
                                    </Button>
                                </XStack>
                            </XStack>
                        ))}
                    </YStack>
                ) : null}

                {/* Fotos */}
                <YStack mb='$4' gap='$2'>
                    <Text color='$textPrimary' fontWeight='bold' fontSize={13}>
                        Fotos obrigatórias
                    </Text>
                    {visibleSlots.map((slot) => {
                        const photo = photos[slot];
                        return (
                            <XStack key={slot} alignItems='center' gap='$3' bg='$surface' borderWidth={1} borderColor='$borderColor' borderRadius='$3' px='$3' py='$2'>
                                <YStack flex={1}>
                                    <Text color='$textPrimary' fontSize={13}>
                                        {SLOT_LABELS[slot] || slot}
                                    </Text>
                                    {photo ? (
                                        <Text color='$textSecondary' fontSize={11}>
                                            {Math.round(photo.size / 1024)} KB · {gps ? `GPS ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : 'sem GPS'}
                                        </Text>
                                    ) : (
                                        <Text color='$textSecondary' fontSize={11}>
                                            Não capturada
                                        </Text>
                                    )}
                                </YStack>
                                <Button size='$3' onPress={() => setCameraSlot(slot)} bg={photo ? '$surface' : '#C62828'} borderWidth={1} borderColor='$borderColor'>
                                    <XStack alignItems='center' gap='$1'>
                                        <FontAwesomeIcon icon={faCamera} size={12} color={photo ? theme['$textPrimary']?.val ?? '#fff' : '#fff'} />
                                        <Button.Text fontSize={11} color={photo ? '$textPrimary' : '#fff'}>
                                            {photo ? 'Refazer' : 'Capturar'}
                                        </Button.Text>
                                    </XStack>
                                </Button>
                            </XStack>
                        );
                    })}
                </YStack>

                {/* Avaria */}
                <YStack mb='$4' gap='$2'>
                    <XStack alignItems='center' justifyContent='space-between' bg='$surface' borderWidth={1} borderColor='$borderColor' borderRadius='$3' px='$3' py='$2'>
                        <Text color='$textPrimary' fontSize={13} flex={1}>
                            O veículo tem avaria?
                        </Text>
                        <Button size='$3' onPress={() => setHasDamage((prev) => !prev)} bg={hasDamage ? '#C62828' : '$surface'} borderWidth={1} borderColor='$borderColor'>
                            <Button.Text fontSize={12} color={hasDamage ? '#fff' : '$textPrimary'}>
                                {hasDamage ? 'SIM' : 'NÃO'}
                            </Button.Text>
                        </Button>
                    </XStack>
                    {hasDamage ? (
                        <>
                            <YStack gap='$1'>
                                <Text color='$textSecondary' fontSize={11}>
                                    Descrição da avaria (obrigatória)
                                </Text>
                                <Input value={damageNotes} onChangeText={setDamageNotes} multiline placeholder='Descreva o dano' bg='$surface' borderWidth={1} borderColor='$borderColor' />
                            </YStack>
                            {!visibleSlots.includes('avaria') ? (
                                <Button onPress={() => setCameraSlot('avaria')} bg='#C62828' borderRadius='$3'>
                                    <XStack alignItems='center' gap='$2'>
                                        <FontAwesomeIcon icon={faCamera} size={13} color='#fff' />
                                        <Button.Text fontSize={13} color='#fff'>
                                            Capturar foto da avaria
                                        </Button.Text>
                                    </XStack>
                                </Button>
                            ) : null}
                        </>
                    ) : null}
                </YStack>

                {/* GPS */}
                <YStack mb='$4' gap='$1'>
                    <Text color='$textPrimary' fontWeight='bold' fontSize={13}>
                        GPS da vistoria
                    </Text>
                    <Text color='$textSecondary' fontSize={12}>
                        {gpsLoading ? 'Capturando posição…' : gps ? `${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}` : 'Sem posição — será capturada no envio'}
                    </Text>
                    <Button onPress={() => void captureGps()} bg='$surface' borderWidth={1} borderColor='$borderColor' alignSelf='flex-start' size='$3'>
                        <Button.Text fontSize={12}>Atualizar GPS</Button.Text>
                    </Button>
                </YStack>

                {/* Fila offline */}
                <YStack bg='$blue-100' borderWidth={1} borderColor='$blue-400' borderRadius='$3' px='$3' py='$2' mb='$4'>
                    <Text color='$blue-800' fontSize={12} fontWeight='bold'>
                        {queueCount} vistoria(s) aguardando envio
                    </Text>
                    {queueCount > 0 ? (
                        <Text color='$blue-800' fontSize={11}>
                            A fila offline reenvia automaticamente quando o app voltar a ter conexão.
                        </Text>
                    ) : null}
                </YStack>

                {resultMessage ? (
                    <YStack bg={resultMessage.ok ? '$green-100' : '$red-100'} borderWidth={1} borderColor={resultMessage.ok ? '$green-500' : '$red-400'} borderRadius='$3' px='$3' py='$2' mb='$4'>
                        <Text color={resultMessage.ok ? '$green-800' : '$red-800'} fontSize={12}>
                            {resultMessage.text}
                        </Text>
                    </YStack>
                ) : null}

                <Button onPress={handleSubmit} disabled={submitting} bg='#C62828' borderRadius='$4' py='$3'>
                    <Button.Text fontSize={15} fontWeight='bold' color='#fff'>
                        {submitting ? 'Enviando…' : 'ENVIAR VISTORIA'}
                    </Button.Text>
                </Button>
            </ScrollView>

            {cameraSlot ? (
                <DvirCamera visible={!!cameraSlot} slotLabel={SLOT_LABELS[cameraSlot] || cameraSlot} onCancel={() => setCameraSlot(null)} onCaptured={handleCaptured(cameraSlot)} />
            ) : null}
        </YStack>
    );
};

export default DvirInspectionScreen;
