import { NextResponse } from 'next/server';
import { getLibraryGroups, saveLibraryGroups, LibraryGroupValidationError } from '@/lib/library-groups';
import type { LibraryGroup } from '@/lib/types';

export async function GET() {
    try {
        return NextResponse.json({ groups: getLibraryGroups() });
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    try {
        const body = await request.json();
        const groups = body?.groups as LibraryGroup[] | undefined;
        if (!Array.isArray(groups)) {
            return NextResponse.json({ error: 'groups must be an array' }, { status: 400 });
        }

        saveLibraryGroups(groups);
        return NextResponse.json({ success: true, groups: getLibraryGroups() });
    } catch (err) {
        if (err instanceof LibraryGroupValidationError) {
            return NextResponse.json({ error: err.message }, { status: 400 });
        }
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}
