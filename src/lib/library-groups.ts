import { getSetting, setSetting } from './database';
import type { LibraryGroup } from './types';

const SETTINGS_KEY = 'library_groups';

export class LibraryGroupValidationError extends Error {}

export function getLibraryGroups(): LibraryGroup[] {
    const raw = getSetting(SETTINGS_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as LibraryGroup[]) : [];
    } catch {
        return [];
    }
}

function validateLibraryGroups(groups: LibraryGroup[]): void {
    const ids = new Set<string>();
    for (const group of groups) {
        if (!group.id) throw new LibraryGroupValidationError(`Library group "${group.name}" is missing an id`);
        if (ids.has(group.id)) throw new LibraryGroupValidationError(`Duplicate library group id: ${group.id}`);
        ids.add(group.id);
    }

    const sectionOwner = new Map<string, string>();
    for (const group of groups) {
        for (const sectionKey of group.sectionKeys) {
            const owner = sectionOwner.get(sectionKey);
            if (owner && owner !== group.id) {
                throw new LibraryGroupValidationError(
                    `Plex library section "${sectionKey}" is assigned to both "${owner}" and "${group.id}"`
                );
            }
            sectionOwner.set(sectionKey, group.id);
        }
    }

    for (const group of groups) {
        for (const influencerId of group.influencedBy) {
            if (influencerId === group.id) {
                throw new LibraryGroupValidationError(`Library group "${group.id}" cannot influence itself`);
            }
            if (!ids.has(influencerId)) {
                throw new LibraryGroupValidationError(
                    `Library group "${group.id}" references unknown influencedBy group "${influencerId}"`
                );
            }
        }
    }
}

export function saveLibraryGroups(groups: LibraryGroup[]): void {
    const sanitized = groups.map((group) => ({
        ...group,
        influencedBy: [...new Set(group.influencedBy.filter((id) => id !== group.id))],
    }));
    validateLibraryGroups(sanitized);
    setSetting(SETTINGS_KEY, JSON.stringify(sanitized));
}

// Returns the union of a group's own section keys and every influencedBy group's section keys.
export function resolveInputSectionKeys(groupId: string, groups: LibraryGroup[]): Set<string> {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return new Set();

    const keys = new Set<string>(group.sectionKeys);
    for (const influencerId of group.influencedBy) {
        const influencer = groups.find((g) => g.id === influencerId);
        if (influencer) {
            for (const key of influencer.sectionKeys) keys.add(key);
        }
    }
    return keys;
}

// Returns [groupId, ...influencedBy] — the group ids whose feedback/taste signal should feed this group.
export function resolveInputGroupIds(groupId: string, groups: LibraryGroup[]): string[] {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return [groupId];
    return [groupId, ...group.influencedBy];
}
