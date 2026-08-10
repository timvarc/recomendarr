import axios, { type AxiosInstance } from 'axios';
import { addLog } from './database';
import { getConfig, type AppConfig } from './config';
import type { WatchlistSignalItem } from './types';

interface SeerrWatchlistEntry {
    title?: string;
    mediaType?: string;
    tmdbId?: number;
}

interface SeerrWatchlistResponse {
    page: number;
    totalPages: number;
    results: SeerrWatchlistEntry[];
}

function createClient(override?: AppConfig['seerr']): AxiosInstance {
    const cfg = override || getConfig().seerr;
    const baseURL = cfg.url.endsWith('/') ? cfg.url.slice(0, -1) : cfg.url;
    return axios.create({
        baseURL,
        timeout: 10000,
        headers: {
            'X-Api-Key': cfg.apiKey,
            Accept: 'application/json',
        },
    });
}

function toMediaType(value?: string): 'movie' | 'series' | null {
    if (value === 'movie') return 'movie';
    if (value === 'tv') return 'series';
    return null;
}

export async function testSeerrConnection(override?: AppConfig['seerr']): Promise<boolean> {
    const cfg = override || getConfig().seerr;
    if (!cfg.enabled || !cfg.url || !cfg.apiKey) {
        return false;
    }

    try {
        const client = createClient(cfg);
        await client.get('/api/v1/status');
        addLog({ level: 'INFO', message: 'Connected to Seerr', source: 'seerr' });
        return true;
    } catch (err) {
        addLog({ level: 'ERROR', message: `Failed to connect to Seerr: ${(err as Error).message}`, source: 'seerr' });
        return false;
    }
}

export async function getSeerrWatchlist(limit = 200, override?: AppConfig['seerr']): Promise<WatchlistSignalItem[]> {
    const cfg = override || getConfig().seerr;
    if (!cfg.enabled || !cfg.watchlistSyncEnabled || !cfg.url || !cfg.apiKey) {
        return [];
    }

    const client = createClient(cfg);
    const all: WatchlistSignalItem[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && all.length < limit) {
        const response = await client.get<SeerrWatchlistResponse>(`/api/v1/user/${cfg.userId}/watchlist`, {
            params: { page },
        });
        totalPages = response.data.totalPages || 1;

        for (const item of response.data.results || []) {
            const mediaType = toMediaType(item.mediaType);
            if (!mediaType || !item.title) continue;
            all.push({
                title: item.title,
                mediaType,
                tmdbId: item.tmdbId,
            });
            if (all.length >= limit) break;
        }

        page += 1;
    }

    addLog({
        level: 'INFO',
        message: `Fetched ${all.length} watchlist items from Seerr`,
        source: 'seerr',
    });

    return all;
}
