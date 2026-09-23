import { describe, expect, it } from 'vitest'

import { ResumeStore } from '../src/upload/storage.js'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function baseState(): Record<string, unknown> {
  return {
    version: 1,
    createdAt: Date.now(),
    objectKey: 'objects/photo.png',
    publicId: 'public-1',
    uploadId: 'upload-1',
    partSize: 1,
    partCount: 1,
    completedParts: [],
    phase: 'uploading',
  }
}

describe('ResumeStore validation', () => {
  it('removes persisted sessions with more than 10,000 parts', () => {
    const storage = new MemoryStorage()
    const store = new ResumeStore(storage)
    storage.setItem('upload', JSON.stringify({
      ...baseState(),
      partCount: 10_001,
    }))

    expect(store.get('upload', 10_001)).toBeUndefined()
    expect(storage.getItem('upload')).toBeNull()
  })

  it('removes persisted sessions containing an oversized ETag', () => {
    const storage = new MemoryStorage()
    const store = new ResumeStore(storage)
    storage.setItem('upload', JSON.stringify({
      ...baseState(),
      completedParts: [{ partNumber: 1, etag: 'e'.repeat(257) }],
      phase: 'uploaded',
    }))

    expect(store.get('upload', 1)).toBeUndefined()
    expect(storage.getItem('upload')).toBeNull()
  })
})
