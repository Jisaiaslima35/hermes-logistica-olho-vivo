/**
 * src/config/panel.ts — ponto único de configuração do PAINEL (web-radio-panel).
 *
 * O app historicamente conversa com o `fleetbase-api` via `@fleetbase/sdk`.
 * As rotas novas (telemetria store-and-forward, DVIR, auditoria do Olho Vivo)
 * NÃO existem no fleetbase-api: elas vivem no painel, que é um serviço
 * próprio (container `fleetbase-web-radio-panel`, porta 8601).
 *
 * Endereço público: https://frota.automacaojs.us
 *
 * ── Sobre autenticação ──────────────────────────────────────────────────────
 * O painel usa JWT de sessão PROPRIO (`verifySessionToken`). O token que o
 * app já guarda (`_driver_token`) é do fleetbase-api e NÃO é válido no
 * painel — enviá-lo faria o painel responder 401 e encerrar a requisição.
 *
 * Portanto:
 *  - `panelFetch()` só injeta `Authorization: Bearer <token>` quando existe um
 *    token DE SESSÃO DO PAINEL (`_panel_session_token`, gravado por
 *    `setPanelSessionToken()`) ou quando o chamador passa `token` explicitamente.
 *  - Sem token de painel, as rotas de motorista continuam funcionando: o
 *    backend resolve a organização pelo campo `organization_id` do body
 *    (fallback operacional documentado em `src/dvir.js` → `resolveOrganization`).
 */

// Endereço base do painel (serviço próprio — NÃO é o fleetbase-api).
export const PANEL_BASE_URL = 'https://frota.automacaojs.us';

// Organização (empresa) usada nos payloads enviados pelo app.
export const PANEL_ORGANIZATION_ID = '5b4e40e1-0348-4051-835d-4cbc33b9cf36';

/** Chave no storage local (MMKV) onde fica o token de sessão do painel. */
export const PANEL_TOKEN_STORAGE_KEY = '_panel_session_token';

/** Chave no storage local (MMKV) com o id do veículo (id do painel). */
export const PANEL_VEHICLE_ID_STORAGE_KEY = '_panel_vehicle_id';

/**
 * Tipos mínimos declarados localmente para não depender de `lib.dom`
 * (o projeto não referencia o DOM).
 */
export interface PanelHeaders {
    [key: string]: string | undefined;
}

export interface PanelRequestInit {
    method?: string;
    headers?: PanelHeaders;
    body?: any;
    signal?: any;
    /** Token explícito de sessão do painel (tem precedência sobre o guardado). */
    token?: string | null;
    [key: string]: any;
}

export interface PanelResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: any;
    json(): Promise<any>;
    text(): Promise<string>;
}

let panelSessionToken: string | null = null;

/**
 * Guarda um token de sessão do painel em memória.
 * Use `setPanelSessionToken(token, { persist: true })` para persistir no MMKV.
 */
export function setPanelSessionToken(token: string | null, options: { persist?: boolean } = {}): void {
    panelSessionToken = token || null;

    if (options.persist) {
        try {
            // require dinâmico: o storage é nativo e pode não estar pronto.
            const { storage } = require('../hooks/use-storage');
            if (token) {
                storage.setString(PANEL_TOKEN_STORAGE_KEY, token);
            } else {
                storage.removeItem(PANEL_TOKEN_STORAGE_KEY);
            }
        } catch (err) {
            console.warn('[panel] Não foi possível persistir o token do painel:', err?.message);
        }
    }
}

/** Token de sessão do painel guardado (memória → MMKV). */
export function getPanelSessionToken(): string | null {
    if (panelSessionToken) {
        return panelSessionToken;
    }

    try {
        const { storage } = require('../hooks/use-storage');
        const stored = storage.getString(PANEL_TOKEN_STORAGE_KEY);
        if (stored) {
            panelSessionToken = stored;
            return stored;
        }
    } catch (err) {
        console.warn('[panel] Não foi possível ler o token do painel:', err?.message);
    }

    return null;
}

/** Id do veículo (id do painel) guardado no storage local. */
export function getPanelVehicleId(): string | null {
    try {
        const { storage } = require('../hooks/use-storage');
        const stored = storage.getString(PANEL_VEHICLE_ID_STORAGE_KEY);
        return stored || null;
    } catch (err) {
        return null;
    }
}

/** Grava o id do veículo (id do painel) no storage local. */
export function setPanelVehicleId(vehicleId: string | null): void {
    try {
        const { storage } = require('../hooks/use-storage');
        if (vehicleId) {
            storage.setString(PANEL_VEHICLE_ID_STORAGE_KEY, vehicleId);
        } else {
            storage.removeItem(PANEL_VEHICLE_ID_STORAGE_KEY);
        }
    } catch (err) {
        console.warn('[panel] Não foi possível gravar o vehicle_id:', err?.message);
    }
}

/**
 * `fetch` no painel: monta a URL, injeta o `Authorization` quando existir
 * token de sessão do painel e devolve a Response.
 *
 * Não lança em erro de rede — o chamador decide (a fila offline precisa
 * distinguir "sem rede" de "erro do servidor").
 */
export async function panelFetch(path: string, init: PanelRequestInit = {}): Promise<PanelResponse> {
    const { token, headers, ...rest } = init;
    const url = `${PANEL_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

    const finalHeaders: PanelHeaders = {
        Accept: 'application/json',
        ...(headers || {}),
    };

    const bearer = token ?? getPanelSessionToken();
    if (bearer) {
        finalHeaders.Authorization = `Bearer ${bearer}`;
    }

    const response = await fetch(url, { ...rest, headers: finalHeaders } as any);
    return response as unknown as PanelResponse;
}

/**
 * Lê a mensagem de erro do painel (o backend sempre devolve
 * `{ error: '...' }` nas rotas novas).
 */
export async function readPanelError(response: PanelResponse, fallback: string): Promise<string> {
    try {
        const body = await response.json();
        if (body && typeof body.error === 'string' && body.error.trim()) {
            return body.error;
        }
        if (body && typeof body.message === 'string' && body.message.trim()) {
            return body.message;
        }
    } catch (err) {
        // corpo não é JSON — usa o fallback
    }
    return fallback;
}
