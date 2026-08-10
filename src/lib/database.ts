import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import type { FeedbackProfile, FeedbackReason, Recommendation, LogEntry, MediaType, RecommendationStatus, WatchedItem, WatchlistSignalItem } from './types';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
    if (db) {
        // If the DB file was externally deleted, reset the connection
        const dbPath = path.resolve(config.database.path);
        if (!fs.existsSync(dbPath)) {
            try { db.close(); } catch { /* ignore */ }
            db = null;
        } else {
            return db;
        }
    }

    const dbPath = path.resolve(config.database.path);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    initializeDatabase(db);
    return db;
}

function initializeDatabase(db: Database.Database) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      year INTEGER,
      media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'series')),
      tmdb_id INTEGER,
      tvdb_id INTEGER,
      imdb_id TEXT,
      overview TEXT,
      poster_url TEXT,
      genres TEXT,
      vote_average REAL,
      source TEXT NOT NULL CHECK(source IN ('tmdb', 'ai')),
      from_watchlist INTEGER NOT NULL DEFAULT 0,
      ai_reasoning TEXT,
      based_on TEXT,
      feedback_reason TEXT,
      feedback_notes TEXT,
      feedback_at TEXT,
      snoozed_until TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'added', 'not_now', 'watched')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL CHECK(level IN ('INFO', 'WARN', 'ERROR', 'DEBUG')),
      message TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watch_history_cache (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      media_type TEXT NOT NULL,
      tmdb_id INTEGER,
      tvdb_id INTEGER,
      imdb_id TEXT,
      last_played TEXT,
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS watched_media_state (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'series')),
      tmdb_id INTEGER,
      tvdb_id INTEGER,
      imdb_id TEXT,
      last_played TEXT,
      play_count INTEGER,
      source TEXT NOT NULL DEFAULT 'media_server',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS seerr_watchlist_signals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'series')),
      tmdb_id INTEGER,
      year INTEGER,
      poster_url TEXT,
      overview TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
    CREATE INDEX IF NOT EXISTS idx_recommendations_tmdb ON recommendations(tmdb_id);
    CREATE INDEX IF NOT EXISTS idx_recommendations_watchlist ON recommendations(from_watchlist);
    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_watched_state_tmdb ON watched_media_state(tmdb_id);
    CREATE INDEX IF NOT EXISTS idx_watched_state_title ON watched_media_state(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_seerr_watchlist_tmdb ON seerr_watchlist_signals(tmdb_id);
    CREATE INDEX IF NOT EXISTS idx_seerr_watchlist_title ON seerr_watchlist_signals(normalized_title);
  `);

    // Dynamic schema evolution for missing columns
    const tableInfo = db.pragma("table_info(recommendations)") as { name: string }[];
    const columns = tableInfo.map(col => col.name);

    if (!columns.includes('language')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN language TEXT;");
    }

    function normalizeTitle(value: string): string {
        return value.trim().toLowerCase();
    }

    function watchedStateId(item: WatchedItem): string {
        if (item.tmdbId) return `tmdb:${item.mediaType}:${item.tmdbId}`;
        if (item.tvdbId) return `tvdb:${item.mediaType}:${item.tvdbId}`;
        if (item.imdbId) return `imdb:${item.mediaType}:${item.imdbId.toLowerCase()}`;
        return `title:${item.mediaType}:${normalizeTitle(item.title)}`;
    }

    function watchlistSignalId(item: WatchlistSignalItem): string {
        if (item.tmdbId) return `tmdb:${item.mediaType}:${item.tmdbId}`;
        return `title:${item.mediaType}:${normalizeTitle(item.title)}`;
    }

    function isRecommendationStatus(value: string): value is RecommendationStatus {
        return ['pending', 'approved', 'rejected', 'added', 'not_now', 'watched'].includes(value);
    }

    function resetExpiredNotNowRecommendations(db: Database.Database) {
        db.prepare(
            "UPDATE recommendations SET status = 'pending', snoozed_until = NULL, updated_at = datetime('now') WHERE status = 'not_now' AND snoozed_until IS NOT NULL AND datetime(snoozed_until) <= datetime('now')"
        ).run();
    }
    if (!columns.includes('feedback_reason')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN feedback_reason TEXT;");
    }
    if (!columns.includes('feedback_notes')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN feedback_notes TEXT;");
    }
    if (!columns.includes('feedback_at')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN feedback_at TEXT;");
    }
    if (!columns.includes('from_watchlist')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN from_watchlist INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columns.includes('snoozed_until')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN snoozed_until TEXT;");
    }

    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recommendations'").get() as { sql?: string } | undefined;
    if (tableSql?.sql && (!tableSql.sql.includes("'not_now'") || !tableSql.sql.includes("'watched'"))) {
        db.exec(`
      CREATE TABLE recommendations_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        year INTEGER,
        language TEXT,
        media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'series')),
        tmdb_id INTEGER,
        tvdb_id INTEGER,
        imdb_id TEXT,
        overview TEXT,
        poster_url TEXT,
        genres TEXT,
        vote_average REAL,
        source TEXT NOT NULL CHECK(source IN ('tmdb', 'ai')),
        from_watchlist INTEGER NOT NULL DEFAULT 0,
        ai_reasoning TEXT,
        based_on TEXT,
        feedback_reason TEXT,
        feedback_notes TEXT,
        feedback_at TEXT,
        snoozed_until TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'added', 'not_now', 'watched')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO recommendations_new (
        id, title, year, language, media_type, tmdb_id, tvdb_id, imdb_id, overview, poster_url, genres, vote_average,
        source, from_watchlist, ai_reasoning, based_on, feedback_reason, feedback_notes, feedback_at, snoozed_until, status, created_at, updated_at
      )
      SELECT
        id, title, year, language, media_type, tmdb_id, tvdb_id, imdb_id, overview, poster_url, genres, vote_average,
        source, COALESCE(from_watchlist, 0), ai_reasoning, based_on, feedback_reason, feedback_notes, feedback_at, snoozed_until, status, created_at, updated_at
      FROM recommendations;

      DROP TABLE recommendations;
      ALTER TABLE recommendations_new RENAME TO recommendations;

      CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
      CREATE INDEX IF NOT EXISTS idx_recommendations_tmdb ON recommendations(tmdb_id);
      CREATE INDEX IF NOT EXISTS idx_recommendations_watchlist ON recommendations(from_watchlist);
    `);
    }
}

// ---- Recommendation CRUD ----

export function addRecommendation(rec: Recommendation): Recommendation {
    const db = getDatabase();
    const id = rec.id || crypto.randomUUID();

    // Check for duplicates by tmdb_id
    if (rec.tmdbId) {
        const existing = db.prepare(
            'SELECT id FROM recommendations WHERE tmdb_id = ? AND media_type = ?'
        ).get(rec.tmdbId, rec.mediaType) as { id: string } | undefined;
        if (existing) return { ...rec, id: existing.id };
    }

    db.prepare(`
    INSERT INTO recommendations (id, title, year, language, media_type, tmdb_id, tvdb_id, imdb_id, overview, poster_url, genres, vote_average, source, from_watchlist, ai_reasoning, based_on, feedback_reason, feedback_notes, feedback_at, snoozed_until, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        id, rec.title, rec.year || null, rec.language || null, rec.mediaType,
        rec.tmdbId || null, rec.tvdbId || null, rec.imdbId || null,
        rec.overview || null, rec.posterUrl || null,
        rec.genres ? JSON.stringify(rec.genres) : null,
        rec.voteAverage || null, rec.source, rec.fromWatchlist ? 1 : 0,
        rec.aiReasoning || null, rec.basedOn || null,
        rec.feedbackReason || null, rec.feedbackNotes || null, rec.feedbackAt || null,
        rec.snoozedUntil || null,
        rec.status
    );

    return { ...rec, id };
}

export function getRecommendations(
    status?: RecommendationStatus | RecommendationStatus[],
    limit = 50,
    offset = 0,
    options?: { watchlist?: 'all' | 'only' | 'exclude' }
): Recommendation[] {
    const db = getDatabase();
    resetExpiredNotNowRecommendations(db);
    let query = 'SELECT * FROM recommendations';
    const params: Array<RecommendationStatus | number> = [];
    const statuses = Array.isArray(status)
        ? status.filter(Boolean)
        : status
            ? [status]
            : [];
    const clauses: string[] = [];

    if (statuses.length > 0) {
        clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
    }
    if (options?.watchlist === 'only') {
        clauses.push('from_watchlist = 1');
    } else if (options?.watchlist === 'exclude') {
        clauses.push('from_watchlist = 0');
    }
    if (clauses.length > 0) {
        query += ` WHERE ${clauses.join(' AND ')}`;
    }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(rowToRecommendation);
}

export function updateRecommendationStatus(
    id: string,
    status: RecommendationStatus,
    feedback?: { reason?: FeedbackReason; notes?: string; snoozeDays?: number }
): boolean {
    const db = getDatabase();
    let result: Database.RunResult;

    if (status === 'rejected') {
        result = db.prepare(
            "UPDATE recommendations SET status = ?, feedback_reason = ?, feedback_notes = ?, feedback_at = datetime('now'), snoozed_until = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(status, feedback?.reason || null, feedback?.notes || null, id);
    } else if (status === 'pending') {
        result = db.prepare(
            "UPDATE recommendations SET status = ?, feedback_reason = NULL, feedback_notes = NULL, feedback_at = NULL, snoozed_until = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(status, id);
    } else if (status === 'not_now') {
        const snoozeDays = Math.max(1, Math.min(365, feedback?.snoozeDays || 30));
        result = db.prepare(
            "UPDATE recommendations SET status = 'not_now', feedback_reason = NULL, feedback_notes = NULL, feedback_at = NULL, snoozed_until = datetime('now', '+' || ? || ' days'), updated_at = datetime('now') WHERE id = ?"
        ).run(snoozeDays, id);
    } else if (status === 'watched') {
        result = db.prepare(
            "UPDATE recommendations SET status = 'watched', feedback_reason = NULL, feedback_notes = NULL, feedback_at = NULL, snoozed_until = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(id);
    } else {
        result = db.prepare(
            "UPDATE recommendations SET status = ?, snoozed_until = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(status, id);
    }

    return result.changes > 0;
}

export function getRecommendationCounts(): Record<string, number> {
    const db = getDatabase();
    resetExpiredNotNowRecommendations(db);
    const rows = db.prepare(
        'SELECT status, COUNT(*) as count FROM recommendations GROUP BY status'
    ).all() as { status: string; count: number }[];

    const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, added: 0, not_now: 0, watched: 0, total: 0 };
    for (const row of rows) {
        if (isRecommendationStatus(row.status)) {
            counts[row.status] = row.count;
        }
        counts.total += row.count;
    }
    return counts;
}

function rowToRecommendation(row: Record<string, unknown>): Recommendation {
    return {
        id: row.id as string,
        title: row.title as string,
        year: row.year as number | undefined,
        language: row.language as string | undefined,
        mediaType: row.media_type as 'movie' | 'series',
        tmdbId: row.tmdb_id as number | undefined,
        tvdbId: row.tvdb_id as number | undefined,
        imdbId: row.imdb_id as string | undefined,
        overview: row.overview as string | undefined,
        posterUrl: row.poster_url as string | undefined,
        genres: row.genres ? JSON.parse(row.genres as string) : undefined,
        voteAverage: row.vote_average as number | undefined,
        source: row.source as 'tmdb' | 'ai',
        fromWatchlist: Number(row.from_watchlist || 0) === 1,
        aiReasoning: row.ai_reasoning as string | undefined,
        basedOn: row.based_on as string | undefined,
        status: row.status as RecommendationStatus,
        snoozedUntil: row.snoozed_until as string | undefined,
        feedbackReason: row.feedback_reason as FeedbackReason | undefined,
        feedbackNotes: row.feedback_notes as string | undefined,
        feedbackAt: row.feedback_at as string | undefined,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
    };
}

function topKeys<T extends string>(counts: Map<T, number>, minCount = 1): T[] {
    return Array.from(counts.entries())
        .filter(([, count]) => count >= minCount)
        .sort((a, b) => b[1] - a[1])
        .map(([key]) => key);
}

function pushMediaType(counts: Map<MediaType, number>, mediaType: MediaType) {
    counts.set(mediaType, (counts.get(mediaType) || 0) + 1);
}

export function getFeedbackProfile(limit = 200): FeedbackProfile {
    const db = getDatabase();
    const rows = db.prepare(`
        SELECT title, media_type, genres, status, feedback_reason
        FROM recommendations
        WHERE status IN ('rejected', 'added')
        ORDER BY updated_at DESC
        LIMIT ?
    `).all(limit) as Array<{
        title: string;
        media_type: MediaType;
        genres: string | null;
        status: 'rejected' | 'added';
        feedback_reason: FeedbackReason | null;
    }>;

    const preferredGenres = new Map<string, number>();
    const avoidedGenres = new Map<string, number>();
    const preferredMediaTypes = new Map<MediaType, number>();
    const avoidedMediaTypes = new Map<MediaType, number>();
    const feedbackReasons = new Map<FeedbackReason, number>();
    const rejectedTitles = new Set<string>();

    for (const row of rows) {
        const genres = row.genres ? (JSON.parse(row.genres) as string[]) : [];
        if (row.status === 'added') {
            pushMediaType(preferredMediaTypes, row.media_type);
            for (const genre of genres) {
                preferredGenres.set(genre.toLowerCase(), (preferredGenres.get(genre.toLowerCase()) || 0) + 1);
            }
            continue;
        }

        rejectedTitles.add(row.title.toLowerCase());
        pushMediaType(avoidedMediaTypes, row.media_type);
        for (const genre of genres) {
            avoidedGenres.set(genre.toLowerCase(), (avoidedGenres.get(genre.toLowerCase()) || 0) + 1);
        }
        if (row.feedback_reason) {
            feedbackReasons.set(row.feedback_reason, (feedbackReasons.get(row.feedback_reason) || 0) + 1);
        }
    }

    const feedbackReasonRecord: Partial<Record<FeedbackReason, number>> = {};
    for (const [reason, count] of feedbackReasons.entries()) {
        feedbackReasonRecord[reason] = count;
    }

    const preferredGenreList = topKeys(preferredGenres, 2);
    const avoidedGenreList = topKeys(avoidedGenres, 2);
    const preferredMediaTypeList = topKeys(preferredMediaTypes, 2);
    const avoidedMediaTypeList = topKeys(avoidedMediaTypes, 2);

    const summaryParts: string[] = [];
    if (preferredGenreList.length > 0) {
        summaryParts.push(`Positive feedback is strongest for ${preferredGenreList.slice(0, 3).join(', ')}.`);
    }
    if (avoidedGenreList.length > 0) {
        summaryParts.push(`Repeated rejection signal exists for ${avoidedGenreList.slice(0, 3).join(', ')}.`);
    }
    const dominantReason = Object.entries(feedbackReasonRecord).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0];
    if (dominantReason) {
        summaryParts.push(`Most common rejection reason is ${dominantReason[0].replaceAll('_', ' ')}.`);
    }

    return {
        rejectedTitles: Array.from(rejectedTitles),
        preferredGenres: preferredGenreList,
        avoidedGenres: avoidedGenreList,
        preferredMediaTypes: preferredMediaTypeList,
        avoidedMediaTypes: avoidedMediaTypeList,
        feedbackReasons: feedbackReasonRecord,
        summary: summaryParts.join(' '),
    };
}

export function syncWatchedMediaState(items: WatchedItem[]): void {
    const db = getDatabase();
    const upsert = db.prepare(`
      INSERT INTO watched_media_state (id, title, normalized_title, media_type, tmdb_id, tvdb_id, imdb_id, last_played, play_count, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'media_server', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        normalized_title = excluded.normalized_title,
        tmdb_id = excluded.tmdb_id,
        tvdb_id = excluded.tvdb_id,
        imdb_id = excluded.imdb_id,
        last_played = excluded.last_played,
        play_count = excluded.play_count,
        updated_at = datetime('now')
    `);

    const tx = db.transaction((payload: WatchedItem[]) => {
        for (const item of payload) {
            upsert.run(
                watchedStateId(item),
                item.title,
                normalizeTitle(item.title),
                item.mediaType,
                item.tmdbId || null,
                item.tvdbId || null,
                item.imdbId || null,
                item.lastPlayedDate || null,
                item.playCount || null
            );
        }
    });
    tx(items);

    db.prepare(
        "UPDATE recommendations SET status = 'watched', snoozed_until = NULL, feedback_reason = NULL, feedback_notes = NULL, feedback_at = NULL, updated_at = datetime('now') WHERE status IN ('pending', 'not_now', 'rejected') AND EXISTS (SELECT 1 FROM watched_media_state wm WHERE wm.media_type = recommendations.media_type AND ((recommendations.tmdb_id IS NOT NULL AND wm.tmdb_id = recommendations.tmdb_id) OR (recommendations.tvdb_id IS NOT NULL AND wm.tvdb_id = recommendations.tvdb_id) OR (recommendations.imdb_id IS NOT NULL AND wm.imdb_id = recommendations.imdb_id) OR wm.normalized_title = lower(recommendations.title)))"
    ).run();
}

export function syncSeerrWatchlistSignals(items: WatchlistSignalItem[]): void {
    const db = getDatabase();
    db.prepare('DELETE FROM seerr_watchlist_signals').run();
    const insert = db.prepare(`
      INSERT INTO seerr_watchlist_signals (id, title, normalized_title, media_type, tmdb_id, year, poster_url, overview, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    const tx = db.transaction((payload: WatchlistSignalItem[]) => {
        for (const item of payload) {
            insert.run(
                watchlistSignalId(item),
                item.title,
                normalizeTitle(item.title),
                item.mediaType,
                item.tmdbId || null,
                item.year || null,
                item.posterUrl || null,
                item.overview || null
            );
        }
    });
    tx(items);
}

export function getSeerrWatchlistSignalSets(): { tmdbIds: Set<number>; titles: Set<string> } {
    const db = getDatabase();
    const rows = db.prepare('SELECT tmdb_id, normalized_title FROM seerr_watchlist_signals').all() as Array<{ tmdb_id: number | null; normalized_title: string }>;
    const tmdbIds = new Set<number>();
    const titles = new Set<string>();
    for (const row of rows) {
        if (row.tmdb_id) tmdbIds.add(row.tmdb_id);
        titles.add(row.normalized_title);
    }
    return { tmdbIds, titles };
}

export function getWatchedMediaSignalSets(): { tmdbIds: Set<number>; tvdbIds: Set<number>; imdbIds: Set<string>; titles: Set<string> } {
    const db = getDatabase();
    const rows = db.prepare('SELECT tmdb_id, tvdb_id, imdb_id, normalized_title FROM watched_media_state').all() as Array<{
        tmdb_id: number | null;
        tvdb_id: number | null;
        imdb_id: string | null;
        normalized_title: string;
    }>;
    const tmdbIds = new Set<number>();
    const tvdbIds = new Set<number>();
    const imdbIds = new Set<string>();
    const titles = new Set<string>();
    for (const row of rows) {
        if (row.tmdb_id) tmdbIds.add(row.tmdb_id);
        if (row.tvdb_id) tvdbIds.add(row.tvdb_id);
        if (row.imdb_id) imdbIds.add(row.imdb_id.toLowerCase());
        titles.add(row.normalized_title);
    }
    return { tmdbIds, tvdbIds, imdbIds, titles };
}

// ---- Logs ----

export function addLog(entry: Omit<LogEntry, 'id' | 'timestamp'>): void {
    const db = getDatabase();
    db.prepare(
        'INSERT INTO logs (level, message, source, details) VALUES (?, ?, ?, ?)'
    ).run(entry.level, entry.message, entry.source, entry.details || null);
}

export function getLogs(level?: string, limit = 100, offset = 0): LogEntry[] {
    const db = getDatabase();
    let query = 'SELECT * FROM logs';
    const params: (string | number)[] = [];

    if (level) {
        query += ' WHERE level = ?';
        params.push(level);
    }
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(query).all(...params) as LogEntry[];
}

export function clearLogs(): void {
    const db = getDatabase();
    db.prepare('DELETE FROM logs').run();
}

// ---- Settings ----

export function getSetting(key: string): string | null {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
    const db = getDatabase();
    db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
    ).run(key, value, value);
}

export function getAllSettings(): Record<string, string> {
    const db = getDatabase();
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}
