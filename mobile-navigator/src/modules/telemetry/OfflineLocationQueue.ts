import { PANEL_ORGANIZATION_ID, getPanelVehicleId, panelFetch, readPanelError } from '../../config/panel';

// `require` local: o projeto não referencia os tipos do Node.
declare const require: (moduleId: string) => any;

/**
 * src/modules/telemetry/OfflineLocationQueue.ts
 *
 * Fila store-and-forward de posições (telemetria).
 *
 * O app do motorista pode ficar horas sem sinal (dead zone, subsolo,
 * economia de bateria). Cada ponto de GPS é guardado LOCALMENTE com o
 * timestamp ORIGINAL do dispositivo e só é removido da fila quando o
 * painel confirma o recebimento (HTTP 2xx).
 *
 * Backend: POST {PANEL_BASE_URL}/api/driver/telemetry/batch
 *   body: { vehicle_id, driver_id, order_id, points: [...] }
 *   - o servidor aceita até 5000 pontos por lote (aqui mandamos 500);
 *   - o servidor reordena por `recorded_at`, mas o cliente já entrega
 *     ordenado (crescente).
 */

export interface TelemetryPoint {
    lat: number;
    lon: number;
    speed_kph: number | null;
    heading_deg: number | null;
    battery_pct: number | null;
    deviation_m: number | null;
    stopped_s: number | null;
    /** Timestamp ORIGINAL do dispositivo (ISO 8601). Nunca "agora" no flush. */
    recorded_at: string;
}

export interface TelemetryContext {
    vehicle_id: string | null;
    driver_id: string | null;
    order_id: string | null;
}

export interface FlushResult {
    ok: boolean;
    sent: number;
    remaining: number;
    error?: string;
}

export type TelemetryQueueListener = (count: number) => void;

const STORAGE_KEY = '@hermes/telemetry/offline-queue';

/** Teto da fila: ao estourar, descarta os MAIS ANTIGOS. */
export const MAX_QUEUE_POINTS = 2000;

/** Tamanho do lote enviado ao painel (o servidor recusa > 5000). */
export const MAX_BATCH_SIZE = 500;

interface StorageLike {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

let storageInstance: StorageLike | null = null;
let storageChecked = false;
let usingMemoryStorage = false;

/**
 * Fallback em memória (Map) — usado quando o AsyncStorage (módulo NATIVO)
 * não está disponível, ou seja, quando o APK ainda não foi rebuildado com a
 * dependência. A fila continua funcionando, só não sobrevive ao app fechar.
 */
const memoryStorage = new Map<string, string>();

const memoryStorageAdapter: StorageLike = {
    getItem: async (key: string) => (memoryStorage.has(key) ? (memoryStorage.get(key) as string) : null),
    setItem: async (key: string, value: string) => {
        memoryStorage.set(key, value);
    },
    removeItem: async (key: string) => {
        memoryStorage.delete(key);
    },
};

/**
 * Carrega o AsyncStorage de forma protegida.
 * O require é LITERAL para o Metro empacotar o módulo; o try/catch protege
 * o app quando o lado nativo ainda não foi linkado (APK sem rebuild).
 */
function getStorage(): StorageLike {
    if (storageChecked) {
        return storageInstance as StorageLike;
    }
    storageChecked = true;

    try {
        const mod = require('@react-native-async-storage/async-storage');
        const candidate = mod?.default ?? mod;
        if (candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function') {
            storageInstance = candidate as StorageLike;
            usingMemoryStorage = false;
            console.log('[OfflineLocationQueue] AsyncStorage disponível — fila persistida em disco.');
        } else {
            storageInstance = memoryStorageAdapter;
            usingMemoryStorage = true;
            console.warn('[OfflineLocationQueue] AsyncStorage sem API esperada — fila apenas em memória.');
        }
    } catch (err) {
        storageInstance = memoryStorageAdapter;
        usingMemoryStorage = true;
        console.warn('[OfflineLocationQueue] AsyncStorage indisponível (APK sem rebuild?) — fila apenas em memória:', err?.message);
    }

    return storageInstance as StorageLike;
}

/** true quando a fila está apenas em memória (sem persistência). */
export function isUsingMemoryStorage(): boolean {
    getStorage();
    return usingMemoryStorage;
}

function sortByRecordedAt(points: TelemetryPoint[]): TelemetryPoint[] {
    return [...points].sort((a, b) => {
        const at = Date.parse(a?.recorded_at ?? '');
        const bt = Date.parse(b?.recorded_at ?? '');
        const aMs = Number.isNaN(at) ? 0 : at;
        const bMs = Number.isNaN(bt) ? 0 : bt;
        return aMs - bMs;
    });
}

function normalizePoint(point: Partial<TelemetryPoint>): TelemetryPoint | null {
    const lat = Number(point?.lat);
    const lon = Number(point?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
    }

    const num = (value: any): number | null => {
        if (value === undefined || value === null || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    };

    const recordedAt = typeof point?.recorded_at === 'string' && point.recorded_at ? point.recorded_at : new Date().toISOString();

    return {
        lat,
        lon,
        speed_kph: num(point?.speed_kph),
        heading_deg: num(point?.heading_deg),
        battery_pct: num(point?.battery_pct),
        deviation_m: num(point?.deviation_m),
        stopped_s: num(point?.stopped_s),
        recorded_at: recordedAt,
    };
}

export class OfflineLocationQueue {
    private points: TelemetryPoint[] = [];
    private context: TelemetryContext = { vehicle_id: null, driver_id: null, order_id: null };
    private listeners: Set<TelemetryQueueListener> = new Set();
    private autoFlushTimer: any = null;
    private persistTimer: any = null;
    private flushing: boolean = false;
    private loaded: boolean = false;

    /** Carrega a fila persistida (idempotente). */
    public async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;

        try {
            const raw = await getStorage().getItem(STORAGE_KEY);
            if (!raw) {
                return;
            }

            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const points = parsed.map((item) => normalizePoint(item)).filter((item): item is TelemetryPoint => !!item);
                this.points = sortByRecordedAt(points).slice(-MAX_QUEUE_POINTS);
                console.log(`[OfflineLocationQueue] ${this.points.length} ponto(s) restaurado(s) do storage.`);
                this.notify();
            }
        } catch (err) {
            console.warn('[OfflineLocationQueue] Falha ao carregar a fila do storage:', err?.message);
        }
    }

    /** Contexto (veículo/motorista/pedido) enviado junto do lote. */
    public setContext(context: Partial<TelemetryContext>): void {
        this.context = { ...this.context, ...context };
    }

    public getContext(): TelemetryContext {
        return { ...this.context };
    }

    /** Adiciona um ponto à fila (mantém o timestamp original do dispositivo). */
    public async enqueue(point: Partial<TelemetryPoint>): Promise<boolean> {
        await this.load();

        const normalized = normalizePoint(point);
        if (!normalized) {
            console.warn('[OfflineLocationQueue] Ponto inválido ignorado (lat/lon).');
            return false;
        }

        this.points.push(normalized);

        // Teto de 2000 pontos: descarta os MAIS ANTIGOS.
        if (this.points.length > MAX_QUEUE_POINTS) {
            const overflow = this.points.length - MAX_QUEUE_POINTS;
            this.points.splice(0, overflow);
            console.warn(`[OfflineLocationQueue] Teto de ${MAX_QUEUE_POINTS} pontos — descartados os ${overflow} mais antigos.`);
        }

        this.notify();
        this.schedulePersist();

        return true;
    }

    /** Quantidade de pontos aguardando envio. */
    public size(): number {
        return this.points.length;
    }

    /** Alias de size() (usado pela UI). */
    public count(): number {
        return this.points.length;
    }

    /** Todos os pontos da fila (ordenados pelo recorded_at original). */
    public all(): TelemetryPoint[] {
        return sortByRecordedAt(this.points);
    }

    /** Limpa a fila (memória + storage). */
    public async clear(): Promise<void> {
        this.points = [];
        this.notify();

        try {
            await getStorage().removeItem(STORAGE_KEY);
        } catch (err) {
            console.warn('[OfflineLocationQueue] Falha ao limpar a fila do storage:', err?.message);
        }
    }

    /**
     * Envia um lote ao painel.
     * Só remove os pontos da fila se o servidor responder 2xx.
     */
    public async flush(): Promise<FlushResult> {
        await this.load();

        if (this.flushing) {
            return { ok: false, sent: 0, remaining: this.points.length, error: 'flush em andamento' };
        }

        if (!this.points.length) {
            return { ok: true, sent: 0, remaining: 0 };
        }

        const ordered = this.all();
        const batch = ordered.slice(0, MAX_BATCH_SIZE);

        this.flushing = true;

        try {
            const body = {
                vehicle_id: this.resolveVehicleId(),
                driver_id: this.resolveDriverId(),
                order_id: this.context.order_id ?? null,
                points: batch,
            };

            const response = await panelFetch('/api/driver/telemetry/batch', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Organization-Id': PANEL_ORGANIZATION_ID,
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const error = await readPanelError(response, `Falha ao enviar lote de telemetria (HTTP ${response.status}).`);
                console.warn(`[OfflineLocationQueue] Lote rejeitado (${response.status}): ${error} — fila mantida.`);
                return { ok: false, sent: 0, remaining: this.points.length, error };
            }

            // Remove SOMENTE os pontos enviados (o servidor confirmou).
            // A comparação é por IDENTIDADE do objeto — assim pontos
            // duplicados (mesmo timestamp/coords) não são removidos errado.
            const sentPoints = new Set<TelemetryPoint>(batch);
            this.points = this.points.filter((point) => !sentPoints.has(point));

            console.log(`[OfflineLocationQueue] Lote de ${batch.length} ponto(s) aceito pelo painel (restam ${this.points.length}).`);
            this.notify();
            await this.persistNow();

            return { ok: true, sent: batch.length, remaining: this.points.length };
        } catch (err) {
            console.warn('[OfflineLocationQueue] Falha de rede ao enviar o lote — fila mantida:', err?.message);
            return { ok: false, sent: 0, remaining: this.points.length, error: String(err?.message ?? err) };
        } finally {
            this.flushing = false;
        }
    }

    /** Envia lotes seguidos até esvaziar a fila (usado no auto-flush). */
    public async flushAll(): Promise<FlushResult> {
        let total = 0;
        let last: FlushResult = { ok: true, sent: 0, remaining: this.size() };

        for (let i = 0; i < 10; i++) {
            if (!this.size()) break;
            last = await this.flush();
            if (!last.ok) break;
            total += last.sent;
        }

        return { ...last, sent: total };
    }

    /** Auto-flush periódico (não bloqueia a UI). */
    public startAutoFlush(intervalMs: number = 60000): void {
        this.stopAutoFlush();

        this.autoFlushTimer = setInterval(() => {
            void this.flush();
        }, intervalMs);

        console.log(`[OfflineLocationQueue] Auto-flush a cada ${Math.round(intervalMs / 1000)}s.`);
    }

    public stopAutoFlush(): void {
        if (this.autoFlushTimer) {
            clearInterval(this.autoFlushTimer);
            this.autoFlushTimer = null;
        }
    }

    /** Assina mudanças do tamanho da fila (para a UI). */
    public onChange(listener: TelemetryQueueListener): () => void {
        this.listeners.add(listener);

        try {
            listener(this.points.length);
        } catch (err) {
            console.warn('[OfflineLocationQueue] Listener falhou:', err);
        }

        return () => {
            this.listeners.delete(listener);
        };
    }

    private notify(): void {
        this.listeners.forEach((listener) => {
            try {
                listener(this.points.length);
            } catch (err) {
                console.warn('[OfflineLocationQueue] Listener falhou:', err);
            }
        });
    }

    private schedulePersist(): void {
        if (this.persistTimer) {
            return;
        }

        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            void this.persistNow();
        }, 1500);
    }

    private async persistNow(): Promise<void> {
        try {
            await getStorage().setItem(STORAGE_KEY, JSON.stringify(this.points));
        } catch (err) {
            console.warn('[OfflineLocationQueue] Falha ao persistir a fila:', err?.message);
        }
    }

    private resolveVehicleId(): string | null {
        if (this.context.vehicle_id) {
            return this.context.vehicle_id;
        }
        return getPanelVehicleId();
    }

    private resolveDriverId(): string | null {
        if (this.context.driver_id) {
            return this.context.driver_id;
        }

        try {
            const { storage } = require('../../hooks/use-storage');
            const driver = storage.getMap('driver');
            const id = (driver as any)?.id;
            return id ? String(id) : null;
        } catch (err) {
            return null;
        }
    }
}

export const offlineLocationQueue = new OfflineLocationQueue();
export default offlineLocationQueue;
