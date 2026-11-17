import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
  async stash(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(this.directory, 'objects', digest), bytes);
    return digest;
  }
}

export class CollectionStore {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  file() {
    return join(this.directory, 'collections.json');
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveAll([]);
    }
    return this;
  }
  async saveAll(collections) {
    const temporary = join(this.directory, `collections-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(collections));
    await rename(temporary, this.file());
  }
  async list() {
    return JSON.parse(await readFile(this.file(), 'utf8'));
  }
  async get(id) {
    return (await this.list()).find(collection => collection.id === id) ?? null;
  }
  async save(collection) {
    const operation = this.pending.then(async () => {
      const collections = await this.list();
      const index = collections.findIndex(item => item.id === collection.id);
      if (index >= 0) collections[index] = collection;
      else collections.push(collection);
      await this.saveAll(collections);
      return collection;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
