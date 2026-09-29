/**
 * Custom Fields — User-defined fields on tasks
 *
 * Inspired by abhi1693/openclaw-mission-control custom-fields component.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type FieldType = "text" | "number" | "date" | "select" | "checkbox" | "url";

export interface CustomFieldDef {
    id: string;
    orgId: string;
    name: string;
    type: FieldType;
    options?: string[];      // for "select" type
    required: boolean;
    defaultValue?: string;
    createdAt: Date | null;
}

export interface CustomFieldValue {
    fieldId: string;
    value: string;
}

export const FIELD_TYPE_CONFIG: Record<FieldType, { label: string; icon: string }> = {
    text: { label: "Text", icon: "📝" },
    number: { label: "Number", icon: "🔢" },
    date: { label: "Date", icon: "📅" },
    select: { label: "Select", icon: "📋" },
    checkbox: { label: "Checkbox", icon: "☑️" },
    url: { label: "URL", icon: "🔗" },
};

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD
// ═══════════════════════════════════════════════════════════════

const FIELDS_COLLECTION = "customFields";

export async function createFieldDef(
    field: Omit<CustomFieldDef, "id" | "createdAt">,
): Promise<string> {
    const ref = await adminDb().collection(FIELDS_COLLECTION).add({
        ...field, createdAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
}

export async function getFieldDefs(orgId: string): Promise<CustomFieldDef[]> {
    const snap = await adminDb().collection(FIELDS_COLLECTION).where("orgId", "==", orgId).get();
    return snap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id, orgId: data.orgId, name: data.name, type: data.type,
            options: data.options, required: data.required || false,
            defaultValue: data.defaultValue,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
        } as CustomFieldDef;
    }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateFieldDef(id: string, updates: Partial<CustomFieldDef>): Promise<void> {
    const { id: _id, createdAt, ...rest } = updates;
    await adminDb().collection(FIELDS_COLLECTION).doc(id).update(rest);
}

export async function deleteFieldDef(id: string): Promise<void> {
    await adminDb().collection(FIELDS_COLLECTION).doc(id).delete();
}
