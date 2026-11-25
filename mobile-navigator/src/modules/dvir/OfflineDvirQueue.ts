import { AppState } from 'react-native';
import RNFS from 'react-native-fs';
import { PANEL_ORGANIZATION_ID, panelFetch, readPanelError } from '../../config/panel';

// `require` local: o projeto não referencia os tipos do Node.
declare const require: (moduleId: string) => any;

/**
 * src/modules/dvir/OfflineDvirQueue.ts
 *
 * Fila offline das vistorias DVIR.
 *
 * Quando o envio falha por falta de rede, a vistoria é guardada LOCALMENTE:
 *  - metadados (campos de texto + metadados das fotos) em AsyncStorage;
 *  - os JPEGs em disco, em `RNFS.DocumentDirectoryPath + '/dvir-queue/'`.
 *
 * Quando o app volta a ter rede, a fila é reenviada AUTOMATICAMENTE:
 *  - no evento de reconexão do AppState (app volta para foreground);
 *  - com backoff exponencial (5 s → 15 s → 45 s → 120 s);
 *  - e num `setInterval` de flush.
 *
 * Cada item tem um `client_id` (UUID gerado no dispositivo) que é reenviado
 * SEMPRE igual, para o servidor poder identificar a reenvio e não duplicar.
 */

export interface DvirPhotoFile {
    /** Slot do checklist (frente, lateral_esquerda, ...). */
    slot: string;
    /** Nome do arquivo dentro de /dvir-queue/. */
    fileName: string;
    /** Caminho absoluto no disco. */
    path: string;
    /** Tamanho em bytes. */
    size: number;
}

export interface DvirQueueItem {
    client_id: string;
    /** Campos de texto do multipart (vehicle_id, shift_type, checklist...). */
    fields: Record<string, any>;
    /** Fotos anexadas (cópias locais dos JPEGs). */
    photos: DvirPhotoFile[];
    created_at: string;
    attempts: number;
    last_error: string | null;
}

export interface DvirFlushItemResult {
    client_id: string;
    ok: boolean;
    error?: string;
}

export interface DvirFlushResult {
    ok: boolean;
    sent: number;
    failed: number;
    remaining: number;
    results: DvirFlushItemResult[];
}

export type DvirQueueListener = (count: number) => void;

const STORAGE_KEY = '@hermes/dvir/offline-queue';
const QUEUE_DIR_NAME = 'dvir-queue';
const RETRY_DELAYS_MS = [5000, 15000, 45000, 120000];

interface StorageLike {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

let storageInstance: StorageLike | null = null;
let storageChecked = false;
let usingMemoryStorage = false;

/** Fallback em memória (Map) — AsyncStorage é módulo NATIVO. */
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
            console.log('[OfflineDvirQueue] AsyncStorage disponível — fila de vistorias persistida.');
        } else {
            storageInstance = memoryStorageAdapter;
            usingMemoryStorage = true;
            console.warn('[OfflineDvirQueue] AsyncStorage sem API esperada — fila apenas em memória.');
        }
    } catch (err) {
        storageInstance = memoryStorageAdapter;
        usingMemoryStorage = true;
        console.warn('[OfflineDvirQueue] AsyncStorage indisponível (APK sem rebuild?) — fila apenas em memória:', err?.message);
    }

    return storageInstance as StorageLike;
}

/** true quando a fila está apenas em memória (sem persistência). */
export function isUsingMemoryStorage(): boolean {
    getStorage();
    return usingMemoryStorage;
}

/** UUID v4 simples (sem depender de crypto nativo). */
export function generateClientId(): string {
    const hex = (length: number): string => {
        let out = '';
        for (let i = 0; i < length; i++) {
            out += Math.floor(Math.random() * 16).toString(16);
        }
        return out;
    };

    return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/** Caminho absoluto da pasta de fila no disco. */
export function getQueueDirectory(): string {
    return `${RNFS.DocumentDirectoryPath}/${QUEUE_DIR_NAME}`;
}

/** Converte `file:///a/b.jpg` em `/a/b.jpg`. */
function stripFileScheme(uri: string): string {
    return String(uri || '').replace(/^file:\/\//, '');
}

async function ensureQueueDirectory(): Promise<string> {
    const dir = getQueueDirectory();
    try {
        const exists = await RNFS.exists(dir);
        if (!exists) {
            await RNFS.mkdir(dir);
        }
    } catch (err) {
        console.warn('[OfflineDvirQueue] Falha ao criar a pasta da fila:', err?.message);
    }
    return dir;
}

export class OfflineDvirQueue {
    private items: DvirQueueItem[] = [];
    private listeners: Set<DvirQueueListener> = new Set();
    private autoFlushTimer: any = null;
    private retryTimer: any = null;
    private appStateSubscription: any = null;
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
                this.items = parsed.filter((item) => item && typeof item.client_id === 'string');
                console.log(`[OfflineDvirQueue] ${this.items.length} vistoria(s) aguardando envio.`);
                this.notify();
            }
        } catch (err) {
            console.warn('[OfflineDvirQueue] Falha ao carregar a fila do storage:', err?.message);
        }
    }

    /**
     * Enfileira uma vistoria.
     * `photos` recebe `{ slot, uri }` — o arquivo é COPIADO para a pasta da
     * fila, porque o arquivo temporário da câmera pode ser apagado pelo
     * sistema antes do reenvio.
     */
    public async enqueue(input: { client_id?: string; fields: Record<string, any>; photos: { slot: string; uri: string; size?: number }[] }): Promise<DvirQueueItem> {
        await this.load();

        const clientId = input.client_id || generateClientId();
        const dir = await ensureQueueDirectory();

        const photos: DvirPhotoFile[] = [];

        for (const photo of input.photos || []) {
            try {
                const source = stripFileScheme(photo.uri);
                const fileName = `${clientId}_${photo.slot}.jpg`;
                const target = `${dir}/${fileName}`;

                const sourceExists = await RNFS.exists(source);
                if (!sourceExists) {
                    console.warn(`[OfflineDvirQueue] Foto ausente no disco, ignorando slot ${photo.slot}.`);
                    continue;
                }

                if (await RNFS.exists(target)) {
                    await RNFS.unlink(target);
                }
                await RNFS.copyFile(source, target);

                let size = photo.size ?? 0;
                if (!size) {
                    try {
                        const stat = await RNFS.stat(target);
                        size = Number(stat?.size ?? 0);
                    } catch (err) {
                        size = 0;
                    }
                }

                photos.push({ slot: photo.slot, fileName, path: target, size });
            } catch (err) {
                console.warn(`[OfflineDvirQueue] Falha ao copiar a foto do slot ${photo.slot}:`, err?.message);
            }
        }

        const item: DvirQueueItem = {
            client_id: clientId,
            fields: { ...(input.fields || {}), client_id: clientId },
            photos,
            created_at: new Date().toISOString(),
            attempts: 0,
            last_error: null,
        };

        this.items.push(item);
        this.notify();
        await this.persistNow();

        console.log(`[OfflineDvirQueue] Vistoria ${clientId} enfileirada (${photos.length} foto(s)).`);

        return item;
    }

    /** Todas as vistorias da fila. */
    public list(): DvirQueueItem[] {
        return [...this.items];
    }

    /** Quantidade de vistorias aguardando envio. */
    public count(): number {
        return this.items.length;
    }

    /** Remove um item da fila (e apaga os arquivos do disco). */
    public async remove(client_id: string): Promise<void> {
        const item = this.items.find((entry) => entry.client_id === client_id);

        this.items = this.items.filter((entry) => entry.client_id !== client_id);
        this.notify();
        await this.persistNow();

        if (item) {
            await this.deleteItemFiles(item);
        }
    }

    /** Envia todas as vistorias da fila. */
    public async flushAll(): Promise<DvirFlushResult> {
        await this.load();

        if (this.flushing) {
            return { ok: false, sent: 0, failed: 0, remaining: this.items.length, results: [] };
        }

        this.flushing = true;
        const results: DvirFlushItemResult[] = [];
        let sent = 0;
        let failed = 0;

        try {
            for (const item of [...this.items]) {
                const result = await this.sendItem(item);
                results.push(result);

                if (result.ok) {
                    sent++;
                    this.items = this.items.filter((entry) => entry.client_id !== item.client_id);
                    await this.deleteItemFiles(item);
                } else {
                    failed++;
                    item.attempts += 1;
                    item.last_error = result.error ?? 'falha desconhecida';
                }
            }
        } finally {
            this.flushing = false;
            this.notify();
            await this.persistNow();
        }

        const remaining = this.items.length;

        if (failed > 0) {
            const lastAttempt = Math.max(...this.items.map((item) => item.attempts), 0);
            this.scheduleRetry(lastAttempt);
        }

        console.log(`[OfflineDvirQueue] Flush concluído — enviados: ${sent}, falharam: ${failed}, na fila: ${remaining}.`);

        return { ok: failed === 0, sent, failed, remaining, results };
    }

    /** Flush periódico + reagendamento com backoff. */
    public startAutoFlush(intervalMs: number = 60000): void {
        this.stopAutoFlush();

        this.autoFlushTimer = setInterval(() => {
            void this.flushAll();
        }, intervalMs);

        // Reconexão: quando o app volta para foreground, tenta reenviar.
        if (!this.appStateSubscription) {
            this.appStateSubscription = AppState.addEventListener('change', (state: string) => {
                if (state === 'active') {
                    console.log('[OfflineDvirQueue] App em foreground — tentando reenviar a fila.');
                    void this.flushAll();
                }
            });
        }
    }

    public stopAutoFlush(): void {
        if (this.autoFlushTimer) {
            clearInterval(this.autoFlushTimer);
            this.autoFlushTimer = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.appStateSubscription) {
            try {
                this.appStateSubscription.remove?.();
            } catch (err) {
                // ignore
            }
            this.appStateSubscription = null;
        }
    }

    /** Assina mudanças da quantidade de vistorias na fila. */
    public onChange(listener: DvirQueueListener): () => void {
        this.listeners.add(listener);

        try {
            listener(this.items.length);
        } catch (err) {
            console.warn('[OfflineDvirQueue] Listener falhou:', err);
        }

        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Envia UMA vistoria (multipart) ao painel. */
    private async sendItem(item: DvirQueueItem): Promise<DvirFlushItemResult> {
        try {
            const form = new FormData();

            Object.keys(item.fields || {}).forEach((key) => {
                const value = item.fields[key];
                if (value === undefined || value === null) return;
                form.append(key, typeof value === 'string' ? value : String(value));
            });

            form.append('organization_id', PANEL_ORGANIZATION_ID);

            for (const photo of item.photos) {
                const exists = await RNFS.exists(photo.path);
                if (!exists) {
                    console.warn(`[OfflineDvirQueue] Arquivo da foto sumiu (${photo.slot}) — pulando.`);
                    continue;
                }

                form.append(photo.slot, {
                    uri: `file://${photo.path}`,
                    type: 'image/jpeg',
                    name: `${photo.slot}.jpg`,
                } as any);
            }

            const response = await panelFetch('/api/driver/dvir', {
                method: 'POST',
                body: form as any,
            });

            if (!response.ok) {
                const error = await readPanelError(response, `Falha ao enviar a vistoria (HTTP ${response.status}).`);
                console.warn(`[OfflineDvirQueue] Envio recusado (${response.status}): ${error}`);
                return { client_id: item.client_id, ok: false, error };
            }

            console.log(`[OfflineDvirQueue] Vistoria ${item.client_id} enviada com sucesso.`);
            return { client_id: item.client_id, ok: true };
        } catch (err) {
            const message = String(err?.message ?? err);
            console.warn('[OfflineDvirQueue] Falha de rede no envio — item mantido na fila:', message);
            return { client_id: item.client_id, ok: false, error: message };
        }
    }

    private scheduleRetry(attempt: number): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }

        const index = Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1);
        const delay = RETRY_DELAYS_MS[index];

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.flushAll();
        }, delay);

        console.log(`[OfflineDvirQueue] Novo reenvio agendado em ${Math.round(delay / 1000)}s.`);
    }

    private async deleteItemFiles(item: DvirQueueItem): Promise<void> {
        for (const photo of item.photos || []) {
            try {
                if (await RNFS.exists(photo.path)) {
                    await RNFS.unlink(photo.path);
                }
            } catch (err) {
                console.warn('[OfflineDvirQueue] Falha ao apagar a foto do disco:', err?.message);
            }
        }
    }

    private notify(): void {
        this.listeners.forEach((listener) => {
            try {
                listener(this.items.length);
            } catch (err) {
                console.warn('[OfflineDvirQueue] Listener falhou:', err);
            }
        });
    }

    private async persistNow(): Promise<void> {
        try {
            await getStorage().setItem(STORAGE_KEY, JSON.stringify(this.items));
        } catch (err) {
            console.warn('[OfflineDvirQueue] Falha ao persistir a fila:', err?.message);
        }
    }
}

export const offlineDvirQueue = new OfflineDvirQueue();
export default offlineDvirQueue;
