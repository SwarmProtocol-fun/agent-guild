/**
 * Minimal in-memory Firestore for exercising lending-service end to end.
 * Supports exactly what the lending code uses: collection/doc refs, auto ids,
 * get/set/update/add, where (==, in, <) + orderBy + limit queries, and
 * transactions whose writes are buffered and only applied if the callback
 * resolves — so a throw after claimUsdcTransferInTxn() really rolls the claim
 * back, like Firestore does. FieldValue.increment / serverTimestamp are
 * / delete are represented by sentinels (see fakeFieldValue).
 */

type Data = Record<string, unknown>;

const INC = Symbol("increment");
const TS = Symbol("serverTimestamp");
const DEL = Symbol("delete");

export const fakeFieldValue = {
    increment: (n: number) => ({ [INC]: n }),
    serverTimestamp: () => ({ [TS]: true }),
    delete: () => ({ [DEL]: true }),
};

export const fakeTimestamp = {
    now: () => ({ seconds: Math.floor(Date.now() / 1000), toMillis: () => Date.now() }),
};

function resolveValue(current: unknown, v: unknown): unknown {
    if (v && typeof v === "object") {
        if (INC in (v as object)) return ((current as number) || 0) + (v as Record<symbol, number>)[INC];
        if (TS in (v as object)) return Date.now();
    }
    return v;
}

function applyFields(base: Data, fields: Data): Data {
    const out = { ...base };
    for (const [k, v] of Object.entries(fields)) {
        if (v && typeof v === "object" && DEL in (v as object)) delete out[k];
        else out[k] = resolveValue(out[k], v);
    }
    return out;
}

let autoId = 0;

export class FakeFirestore {
    store = new Map<string, Map<string, Data>>();

    col(name: string): Map<string, Data> {
        if (!this.store.has(name)) this.store.set(name, new Map());
        return this.store.get(name)!;
    }

    all(name: string): Array<Data & { id: string }> {
        return [...this.col(name).entries()].map(([id, d]) => ({ id, ...d }));
    }

    collection(name: string) {
        return new FakeQuery(this, name, []);
    }

    async runTransaction<T>(fn: (txn: FakeTxn) => Promise<T>): Promise<T> {
        const txn = new FakeTxn(this);
        const result = await fn(txn);
        txn.commit();
        return result;
    }
}

export class FakeDocRef {
    constructor(public db: FakeFirestore, public collectionName: string, public id: string) {}

    get ref() {
        return this;
    }

    async get() {
        return snapshot(this, this.db.col(this.collectionName).get(this.id));
    }

    async set(data: Data) {
        this.db.col(this.collectionName).set(this.id, applyFields({}, data));
    }

    async update(data: Data) {
        const col = this.db.col(this.collectionName);
        const cur = col.get(this.id);
        if (!cur) throw new Error(`No document to update: ${this.collectionName}/${this.id}`);
        col.set(this.id, applyFields(cur, data));
    }

    async create(data: Data) {
        const col = this.db.col(this.collectionName);
        if (col.has(this.id)) throw new Error("ALREADY_EXISTS");
        col.set(this.id, applyFields({}, data));
    }
}

function snapshot(ref: FakeDocRef, data: Data | undefined) {
    return {
        id: ref.id,
        ref,
        exists: !!data,
        data: () => (data ? { ...data } : undefined),
    };
}

type Filter = { field: string; op: string; value: unknown };

export class FakeQuery {
    private order: { field: string; dir: "asc" | "desc" } | null = null;
    private max: number | null = null;

    constructor(public db: FakeFirestore, public collectionName: string, private filters: Filter[]) {}

    doc(id?: string) {
        return new FakeDocRef(this.db, this.collectionName, id ?? `auto${++autoId}`);
    }

    async add(data: Data) {
        const ref = this.doc();
        await ref.set(data);
        return ref;
    }

    where(field: string, op: string, value: unknown) {
        const q = new FakeQuery(this.db, this.collectionName, [...this.filters, { field, op, value }]);
        q.order = this.order;
        q.max = this.max;
        return q;
    }

    orderBy(field: string, dir: "asc" | "desc" = "asc") {
        const q = new FakeQuery(this.db, this.collectionName, this.filters);
        q.order = { field, dir };
        q.max = this.max;
        return q;
    }

    limit(n: number) {
        const q = new FakeQuery(this.db, this.collectionName, this.filters);
        q.order = this.order;
        q.max = n;
        return q;
    }

    async get() {
        let rows = [...this.db.col(this.collectionName).entries()].filter(([, d]) =>
            this.filters.every(({ field, op, value }) => {
                const v = d[field];
                if (op === "==") return v === value;
                if (op === "in") return (value as unknown[]).includes(v);
                if (op === "<") return typeof v === "number" && v < (value as number);
                throw new Error(`Unsupported op ${op}`);
            }),
        );
        if (this.order) {
            const { field, dir } = this.order;
            rows.sort(([, a], [, b]) => ((a[field] as number) - (b[field] as number)) * (dir === "asc" ? 1 : -1));
        }
        if (this.max !== null) rows = rows.slice(0, this.max);
        const docs = rows.map(([id, d]) => snapshot(new FakeDocRef(this.db, this.collectionName, id), d));
        return { docs, size: docs.length, empty: docs.length === 0 };
    }
}

export class FakeTxn {
    private writes: Array<() => void> = [];
    private wrote = false;

    constructor(private db: FakeFirestore) {}

    async get(target: FakeDocRef | FakeQuery) {
        if (this.wrote) throw new Error("Firestore transactions require all reads before writes");
        return target.get();
    }

    set(ref: FakeDocRef, data: Data) {
        this.wrote = true;
        this.writes.push(() => this.db.col(ref.collectionName).set(ref.id, applyFields({}, data)));
    }

    update(ref: FakeDocRef, data: Data) {
        this.wrote = true;
        this.writes.push(() => {
            const col = this.db.col(ref.collectionName);
            const cur = col.get(ref.id);
            if (!cur) throw new Error(`No document to update: ${ref.collectionName}/${ref.id}`);
            col.set(ref.id, applyFields(cur, data));
        });
    }

    private creates: FakeDocRef[] = [];

    create(ref: FakeDocRef, data: Data) {
        this.wrote = true;
        this.creates.push(ref);
        this.writes.push(() => this.db.col(ref.collectionName).set(ref.id, applyFields({}, data)));
    }

    /** All-or-nothing, like Firestore: a failing create() aborts every write in the transaction. */
    commit() {
        for (const ref of this.creates) {
            if (this.db.col(ref.collectionName).has(ref.id)) throw new Error("ALREADY_EXISTS");
        }
        for (const w of this.writes) w();
    }
}
