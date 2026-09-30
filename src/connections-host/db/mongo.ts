import type { Document, MongoClient, MongoClientOptions } from 'mongodb';
import { readFile } from 'node:fs/promises';
import { maskValue } from '../format';
import type { MongoDriver } from './driver';
import type { Target } from './target';
import { projectPath } from './target';
import { scalarText } from '@shared/utils/text';

const IDLE_MS = 5 * 60_000;

function urlOf(t: Target): string {
  if (t.url) return t.url;
  const auth = t.user
    ? `${encodeURIComponent(t.user)}${t.password !== undefined ? `:${encodeURIComponent(t.password)}` : ''}@`
    : '';
  const query = new URLSearchParams(t.options).toString();
  const host = t.host.includes(':') && !t.host.startsWith('[') ? `[${t.host}]` : t.host;
  return `mongodb://${auth}${host}:${t.port ?? 27017}/${encodeURIComponent(t.database ?? '')}${query ? `?${query}` : ''}`;
}

const asObject = (v: unknown, name: string): Document => {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`\`${name}\` must be an object.`);
  return v;
};

const typeOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (typeof v === 'object') {
    const bson = (v as { _bsontype?: string })._bsontype;
    return bson ? bson.toLowerCase() : 'object';
  }
  return typeof v;
};

/** MongoDB (`mongodb`): the operations of `oxy_mongo` with server-side time limits. */
export async function createMongo(t: Target, o: { root: string }): Promise<MongoDriver> {
  const { MongoClient: Client, BSON } = await import('mongodb');
  const options: MongoClientOptions = {
    maxPoolSize: 2,
    minPoolSize: 0,
    maxIdleTimeMS: IDLE_MS,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    appName: 'Oxytocin',
  };
  const url = urlOf(t);
  const explicitTls = /[?&](tls|ssl)=/i.test(url) || url.startsWith('mongodb+srv:');
  if (!explicitTls) {
    if (t.tls.mode === 'require') Object.assign(options, { tls: true, tlsAllowInvalidCertificates: true });
    else if (t.tls.mode === 'verify') {
      options.tls = true;
      if (t.tls.caPath) options.tlsCAFile = projectPath(o.root, t.tls.caPath);
    }
  }
  if (t.tls.mode === 'verify' && t.tls.caPath) await readFile(projectPath(o.root, t.tls.caPath));
  let client: MongoClient | undefined;
  let ready: Promise<MongoClient> | undefined;
  const getClient = () => {
    ready ??= (async () => {
      const c = new Client(url, options);
      try {
        await c.connect();
        client = c;
        return c;
      } catch (e) {
        await c.close().catch(() => undefined);
        ready = undefined;
        throw e;
      }
    })();
    return ready;
  };
  const db = async () => (await getClient()).db(t.database || undefined);
  /** Arguments in Extended JSON (`{"$oid": …}`, `{"$date": …}`) become BSON values. */
  const ejson = (v: unknown): Document => BSON.EJSON.deserialize(v as Document, { relaxed: true }) as Document;

  return {
    family: 'mongodb',
    async version(timeoutMs) {
      const info = await (await db()).admin().command({ buildInfo: 1 }, { timeoutMS: timeoutMs });
      return `MongoDB ${String(info['version'])}`;
    },

    async run(collectionName, operation, rawArgs, q) {
      const args = ejson(rawArgs);
      const coll = (await db()).collection(collectionName);
      const maxTimeMS = q.timeoutMs;
      const filter = asObject(args['filter'], 'filter');
      switch (operation) {
        case 'find': {
          const limit = Math.min(Number(args['limit']) > 0 ? Number(args['limit']) : q.maxRows, q.maxRows);
          const cursor = coll.find(filter, {
            ...(args['projection'] ? { projection: asObject(args['projection'], 'projection') } : {}),
            ...(args['sort'] ? { sort: asObject(args['sort'], 'sort') } : {}),
            ...(Number(args['skip']) > 0 ? { skip: Number(args['skip']) } : {}),
            limit: limit + 1,
            maxTimeMS,
          });
          const documents = await cursor.toArray();
          const more = documents.length > limit;
          let total: number | null = documents.length;
          if (more)
            total = await coll.countDocuments(filter, { maxTimeMS: Math.min(maxTimeMS, 5000) }).catch(() => null);
          return { documents: documents.slice(0, limit), more, total };
        }
        case 'findOne': {
          const doc = await coll.findOne(filter, {
            ...(args['projection'] ? { projection: asObject(args['projection'], 'projection') } : {}),
            ...(args['sort'] ? { sort: asObject(args['sort'], 'sort') } : {}),
            maxTimeMS,
          });
          return { documents: doc ? [doc] : [], total: doc ? 1 : 0 };
        }
        case 'aggregate': {
          const pipeline: unknown = args['pipeline'];
          if (!Array.isArray(pipeline)) throw new Error('`pipeline` must be an array of stages.');
          const cursor = coll.aggregate(pipeline as Document[], { maxTimeMS, allowDiskUse: false });
          const documents: Document[] = [];
          let more = false;
          for await (const doc of cursor) {
            if (documents.length < q.maxRows) documents.push(doc);
            else {
              more = true;
              break;
            }
          }
          await cursor.close();
          return { documents, more, total: more ? null : documents.length };
        }
        case 'countDocuments':
          return { value: await coll.countDocuments(filter, { maxTimeMS }) };
        case 'estimatedDocumentCount':
          return { value: await coll.estimatedDocumentCount({ maxTimeMS }) };
        case 'distinct': {
          const field: unknown = args['field'];
          if (typeof field !== 'string' || !field) throw new Error('Pass `field`.');
          const values = await coll.distinct(field, filter, { maxTimeMS });
          return {
            documents: values.slice(0, q.maxRows) as unknown[],
            more: values.length > q.maxRows,
            total: values.length,
          };
        }
        case 'listIndexes':
          return { documents: await coll.listIndexes().toArray() };
        case 'collStats':
          return {
            documents: await coll.aggregate([{ $collStats: { storageStats: {}, count: {} } }], { maxTimeMS }).toArray(),
          };
        case 'insertOne':
          return { value: await coll.insertOne(asObject(args['document'], 'document'), { maxTimeMS }) };
        case 'insertMany': {
          const documents: unknown = args['documents'];
          if (!Array.isArray(documents)) throw new Error('`documents` must be an array.');
          return { value: await coll.insertMany(documents as Document[], { maxTimeMS }) };
        }
        case 'updateOne':
        case 'updateMany': {
          const update: unknown = args['update'];
          if (!update || typeof update !== 'object') throw new Error('Pass `update` (an update document or pipeline).');
          const opts = { upsert: args['upsert'] === true, maxTimeMS };
          return {
            value:
              operation === 'updateOne'
                ? await coll.updateOne(filter, update, opts)
                : await coll.updateMany(filter, update, opts),
          };
        }
        case 'replaceOne':
          return {
            value: await coll.replaceOne(filter, asObject(args['replacement'], 'replacement'), {
              upsert: args['upsert'] === true,
              maxTimeMS,
            }),
          };
        case 'deleteOne':
          return { value: await coll.deleteOne(filter, { maxTimeMS }) };
        case 'deleteMany':
          return { value: await coll.deleteMany(filter, { maxTimeMS }) };
        default:
          throw new Error(`Unknown operation ${operation}.`);
      }
    },

    async schema(r) {
      const database = await db();
      if (!r.collection) {
        const collections = await database.listCollections({}, { nameOnly: false }).toArray();
        const lines: string[] = [];
        for (const c of collections.slice(0, 200)) {
          const count =
            c.type === 'collection'
              ? await database
                  .collection(c.name)
                  .estimatedDocumentCount({ maxTimeMS: Math.min(r.timeoutMs, 3000) })
                  .catch(() => null)
              : null;
          lines.push(
            `- ${c.name} [${c.type ?? 'collection'}${count !== null ? `, ~${count.toLocaleString('en-US')} documents` : ''}]`,
          );
        }
        if (collections.length > 200) lines.push(`… and ${collections.length - 200} more.`);
        return `${lines.join('\n') || 'No collections.'}\nPass \`table\` (a collection) for its indexes and the shape of its documents.`;
      }
      const coll = database.collection(r.collection);
      const indexes = await coll
        .listIndexes()
        .toArray()
        .catch(() => []);
      const sample = await coll.aggregate([{ $sample: { size: 20 } }], { maxTimeMS: r.timeoutMs }).toArray();
      const fields = new Map<string, { types: Set<string>; count: number; example?: string }>();
      const visit = (value: unknown, path: string, depth: number) => {
        const entry = fields.get(path) ?? { types: new Set<string>(), count: 0 };
        entry.types.add(typeOf(value));
        entry.count++;
        if (entry.example === undefined && value !== null && typeof value !== 'object')
          entry.example = scalarText(value).slice(0, 60);
        fields.set(path, entry);
        if (
          depth < 3 &&
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          !(value as { _bsontype?: string })._bsontype &&
          !(value instanceof Date)
        )
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, `${path}.${k}`, depth + 1);
      };
      for (const doc of sample) {
        const masked = maskValue(doc, r.masking) as Record<string, unknown>;
        for (const [k, v] of Object.entries(masked)) visit(v, k, 1);
      }
      const lines = [`${r.collection}: ${sample.length} sampled document${sample.length === 1 ? '' : 's'}`];
      for (const [path, f] of fields)
        lines.push(
          `  ${path}: ${[...f.types].join(' | ')}${f.count < sample.length ? ` (in ${f.count} of ${sample.length})` : ''}${f.example !== undefined ? ` e.g. ${JSON.stringify(f.example)}` : ''}`,
        );
      for (const ix of indexes) {
        const info = ix as { name?: unknown; key?: unknown; unique?: unknown };
        lines.push(`  INDEX ${scalarText(info.name)}: ${JSON.stringify(info.key)}${info.unique ? ' UNIQUE' : ''}`);
      }
      return lines.join('\n');
    },

    async close() {
      const c = client;
      client = undefined;
      ready = undefined;
      await c?.close().catch(() => undefined);
    },
  };
}

/** Documents as relaxed Extended JSON (ObjectId as {"$oid": …}, dates as {"$date": …}). */
export async function toExtendedJson(value: unknown): Promise<string> {
  const { BSON } = await import('mongodb');
  return BSON.EJSON.stringify(value, { relaxed: true });
}
