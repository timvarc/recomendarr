'use client';

import { useEffect, useState } from 'react';
import type { ConnectionResult, DiscoveredLibrary } from './models';
import type { LibraryGroup } from '@/lib/types';

interface LibraryGroupsPanelProps {
    connResults: Record<string, ConnectionResult>;
    onTest: (service: string, settings?: Record<string, string>) => Promise<ConnectionResult['data'] | null>;
    toast: (msg: string, type?: string) => void;
    onSaved?: () => void;
}

interface ArrOption {
    id: number;
    name?: string;
    path?: string;
    freeSpace?: number;
}

function slugify(name: string, taken: Set<string>): string {
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
        candidate = `${base}-${suffix++}`;
    }
    return candidate;
}

export function LibraryGroupsPanel({ connResults, onTest, toast, onSaved }: LibraryGroupsPanelProps) {
    const [groups, setGroups] = useState<LibraryGroup[]>([]);
    const [savedSnapshot, setSavedSnapshot] = useState('');
    const [sections, setSections] = useState<DiscoveredLibrary[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [discovering, setDiscovering] = useState(false);
    const [sonarrOptions, setSonarrOptions] = useState<{ profiles: ArrOption[]; folders: ArrOption[] }>({ profiles: [], folders: [] });
    const [radarrOptions, setRadarrOptions] = useState<{ profiles: ArrOption[]; folders: ArrOption[] }>({ profiles: [], folders: [] });

    useEffect(() => {
        fetch('/api/library-groups')
            .then((res) => res.json())
            .then((data) => {
                const loadedGroups: LibraryGroup[] = Array.isArray(data.groups) ? data.groups : [];
                setGroups(loadedGroups);
                setSavedSnapshot(JSON.stringify(loadedGroups));
            })
            .catch(() => {})
            .finally(() => setLoaded(true));

        const existingLibraries = connResults.mediaServer?.data?.libraries;
        if (existingLibraries && existingLibraries.length > 0) {
            setSections(existingLibraries);
        }

        Promise.all([
            fetch('/api/arr-options?type=series').then((res) => res.json()).catch(() => null),
            fetch('/api/arr-options?type=movie').then((res) => res.json()).catch(() => null),
        ]).then(([series, movie]) => {
            if (series) setSonarrOptions({ profiles: series.profiles || [], folders: series.folders || [] });
            if (movie) setRadarrOptions({ profiles: movie.profiles || [], folders: movie.folders || [] });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const discoverLibraries = async () => {
        setDiscovering(true);
        try {
            const data = await onTest('mediaServer');
            const libraries = data?.libraries;
            if (libraries && libraries.length > 0) {
                setSections(libraries);
                toast(`Found ${libraries.length} Plex libraries`, 'success');
            } else {
                toast('No libraries found — check your media server connection (Jellyfin/Emby library discovery is not yet supported)', 'error');
            }
        } finally {
            setDiscovering(false);
        }
    };

    const addGroup = () => {
        const taken = new Set(groups.map((g) => g.id));
        const name = `Group ${groups.length + 1}`;
        setGroups((prev) => [
            ...prev,
            { id: slugify(name, taken), name, mediaType: 'series', sectionKeys: [], influencedBy: [], aiEnabled: true },
        ]);
    };

    const updateGroup = (id: string, patch: Partial<LibraryGroup>) => {
        setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
    };

    const removeGroup = (id: string) => {
        setGroups((prev) =>
            prev
                .filter((g) => g.id !== id)
                .map((g) => ({ ...g, influencedBy: g.influencedBy.filter((otherId) => otherId !== id) }))
        );
    };

    const toggleSection = (group: LibraryGroup, sectionKey: string) => {
        const has = group.sectionKeys.includes(sectionKey);
        updateGroup(group.id, {
            sectionKeys: has
                ? group.sectionKeys.filter((k) => k !== sectionKey)
                : [...group.sectionKeys, sectionKey],
        });
    };

    const toggleInfluencer = (group: LibraryGroup, otherId: string) => {
        const has = group.influencedBy.includes(otherId);
        updateGroup(group.id, {
            influencedBy: has
                ? group.influencedBy.filter((id) => id !== otherId)
                : [...group.influencedBy, otherId],
        });
    };

    const sectionOwner = (sectionKey: string) => groups.find((g) => g.sectionKeys.includes(sectionKey));

    const isDirty = loaded && JSON.stringify(groups) !== savedSnapshot;

    const handleSave = async () => {
        setSaving(true);
        try {
            const response = await fetch('/api/library-groups', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ groups }),
            });
            const data = await response.json();
            if (!data.success) {
                toast(data.error || 'Failed to save library groups', 'error');
                return;
            }
            setSavedSnapshot(JSON.stringify(groups));
            toast('Library groups saved', 'success');
            onSaved?.();
        } catch (error) {
            toast((error as Error).message, 'error');
        } finally {
            setSaving(false);
        }
    };

    if (!loaded) {
        return (
            <div className="loading-panel">
                <span className="spinner spinner-lg" />
            </div>
        );
    }

    return (
        <div className="settings-stack">
            <section className="settings-card">
                <div className="section-heading">
                    <div>
                        <p className="section-kicker">Plex Libraries</p>
                        <h3>Split recommendations by library</h3>
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={discoverLibraries} disabled={discovering}>
                        {discovering ? 'Discovering...' : 'Discover libraries'}
                    </button>
                </div>
                <p className="helper-copy">
                    Group your Plex libraries (e.g. &quot;TV Shows&quot;, &quot;Kid Shows&quot;, &quot;Movies&quot;) so each gets its own
                    recommendation queue and its own Sonarr/Radarr destination. A library can belong to only one group.
                    Only Plex library discovery is supported today — Jellyfin and Emby installs can skip this tab and
                    everything behaves exactly as before.
                </p>

                {sections.length === 0 ? (
                    <p className="helper-copy">No libraries discovered yet. Click &quot;Discover libraries&quot; above.</p>
                ) : (
                    <div className="chip-grid">
                        {sections.map((section) => {
                            const owner = sectionOwner(section.key);
                            return (
                                <span key={section.key} className={`chip-button ${owner ? 'active' : ''}`}>
                                    {section.title} ({section.type}){owner ? ` → ${owner.name}` : ''}
                                </span>
                            );
                        })}
                    </div>
                )}
            </section>

            {groups.map((group) => (
                <section className="settings-card" key={group.id}>
                    <div className="section-heading">
                        <div>
                            <p className="section-kicker">{group.mediaType === 'movie' ? 'Movie group' : 'Series group'}</p>
                            <input
                                type="text"
                                value={group.name}
                                onChange={(event) => updateGroup(group.id, { name: event.target.value })}
                                placeholder="Group name"
                            />
                        </div>
                        <button className="btn btn-ghost btn-sm" onClick={() => removeGroup(group.id)}>
                            Remove
                        </button>
                    </div>

                    <div className="field-row">
                        <label>Media type</label>
                        <div className="chip-grid">
                            {(['movie', 'series'] as const).map((type) => (
                                <button
                                    key={type}
                                    type="button"
                                    className={`chip-button ${group.mediaType === type ? 'active' : ''}`}
                                    onClick={() => updateGroup(group.id, { mediaType: type, sectionKeys: [] })}
                                >
                                    {type}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="field-row">
                        <label>Plex libraries in this group</label>
                        <div className="chip-grid">
                            {sections
                                .filter((section) => section.type === group.mediaType)
                                .map((section) => {
                                    const owner = sectionOwner(section.key);
                                    const ownedByOther = Boolean(owner && owner.id !== group.id);
                                    return (
                                        <button
                                            key={section.key}
                                            type="button"
                                            disabled={ownedByOther}
                                            className={`chip-button ${group.sectionKeys.includes(section.key) ? 'active' : ''}`}
                                            onClick={() => toggleSection(group, section.key)}
                                            title={ownedByOther ? `Already assigned to ${owner?.name}` : undefined}
                                        >
                                            {section.title}
                                        </button>
                                    );
                                })}
                            {sections.filter((section) => section.type === group.mediaType).length === 0 && (
                                <span className="helper-copy">No {group.mediaType} libraries discovered yet.</span>
                            )}
                        </div>
                    </div>

                    {groups.length > 1 && (
                        <div className="field-row">
                            <label>Also learn from (cross-influence)</label>
                            <div className="chip-grid">
                                {groups
                                    .filter((other) => other.id !== group.id)
                                    .map((other) => (
                                        <button
                                            key={other.id}
                                            type="button"
                                            className={`chip-button ${group.influencedBy.includes(other.id) ? 'active' : ''}`}
                                            onClick={() => toggleInfluencer(group, other.id)}
                                        >
                                            {other.name}
                                        </button>
                                    ))}
                            </div>
                            <small>
                                Watch history and taste signal from selected groups also shape this group&apos;s recommendations,
                                without letting their titles show up as candidates here.
                            </small>
                        </div>
                    )}

                    <div className="settings-grid two">
                        {group.mediaType === 'series' ? (
                            <>
                                <label className="field-row">
                                    <span>Sonarr quality profile</span>
                                    <select
                                        value={group.qualityProfileId ?? ''}
                                        onChange={(event) => updateGroup(group.id, { qualityProfileId: event.target.value ? Number(event.target.value) : undefined })}
                                    >
                                        <option value="">Use global default</option>
                                        {sonarrOptions.profiles.map((profile) => (
                                            <option key={profile.id} value={profile.id}>{profile.name}</option>
                                        ))}
                                    </select>
                                </label>
                                <label className="field-row">
                                    <span>Sonarr root folder</span>
                                    <select
                                        value={group.rootFolder ?? ''}
                                        onChange={(event) => updateGroup(group.id, { rootFolder: event.target.value || undefined })}
                                    >
                                        <option value="">Use global default</option>
                                        {sonarrOptions.folders.map((folder) => (
                                            <option key={folder.id} value={folder.path}>{folder.path}</option>
                                        ))}
                                    </select>
                                </label>
                            </>
                        ) : (
                            <>
                                <label className="field-row">
                                    <span>Radarr quality profile</span>
                                    <select
                                        value={group.qualityProfileId ?? ''}
                                        onChange={(event) => updateGroup(group.id, { qualityProfileId: event.target.value ? Number(event.target.value) : undefined })}
                                    >
                                        <option value="">Use global default</option>
                                        {radarrOptions.profiles.map((profile) => (
                                            <option key={profile.id} value={profile.id}>{profile.name}</option>
                                        ))}
                                    </select>
                                </label>
                                <label className="field-row">
                                    <span>Radarr root folder</span>
                                    <select
                                        value={group.rootFolder ?? ''}
                                        onChange={(event) => updateGroup(group.id, { rootFolder: event.target.value || undefined })}
                                    >
                                        <option value="">Use global default</option>
                                        {radarrOptions.folders.map((folder) => (
                                            <option key={folder.id} value={folder.path}>{folder.path}</option>
                                        ))}
                                    </select>
                                </label>
                            </>
                        )}
                    </div>

                    <label className="field-row">
                        <span>Generate AI recommendations for this group</span>
                        <label className="switch">
                            <input
                                type="checkbox"
                                checked={group.aiEnabled !== false}
                                onChange={(event) => updateGroup(group.id, { aiEnabled: event.target.checked })}
                            />
                            <span className="slider" />
                        </label>
                    </label>
                </section>
            ))}

            <section className="settings-card">
                <div className="section-heading">
                    <div>
                        <p className="section-kicker">Add another group</p>
                        <h3>New library group</h3>
                    </div>
                    <button className="btn btn-secondary" onClick={addGroup}>+ Add library group</button>
                </div>
                <p className="helper-copy">
                    Leaving no groups configured keeps the classic single, unfiltered recommendation queue.
                </p>
            </section>

            <section className={`settings-card ${isDirty ? 'dirty' : ''}`}>
                <div className="section-heading">
                    <div>
                        <strong>{isDirty ? 'Unsaved library group changes' : 'Library groups saved'}</strong>
                        <p>
                            {isDirty
                                ? 'Save to start scoping recommendations by group on the next engine run.'
                                : 'Your library groups are synced with the stored configuration.'}
                        </p>
                    </div>
                    <button className="btn btn-primary btn-lg" onClick={handleSave} disabled={saving || !isDirty}>
                        {saving ? (
                            <>
                                <span className="spinner" />
                                Saving...
                            </>
                        ) : (
                            'Save library groups'
                        )}
                    </button>
                </div>
            </section>
        </div>
    );
}
