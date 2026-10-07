import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeAppEnv } from '../../testing/app-env.fixture';
import { LocalStorageAdapter } from './local-storage.adapter';
import {
  requireLocalPath,
  StorageInvalidKeyError,
  StorageObjectMissingError,
} from './storage.adapter';
import {
  dateDirOf,
  manifestKey,
  parseReleaseKey,
  releaseFileKey,
  releaseKey,
  trashKey,
  uploadTempKey,
  workDirKey,
} from './storage-keys';

/**
 * 存储层单测（计划 M3-T1 判据）：
 * ① key 形态严格等于机制 §1.2；② `tmp/` 与 `releases/` 同挂载点的启动自查真的在判设备号；
 * ③ 一切越界 key 都拿不到绝对路径（这是 commit 的 rename 与 GC 的递归删除唯一的安全边界）。
 */

describe('存储 key 规范（机制 §1.2）', () => {
  it('版本产物根是 releases/{projectId}/{prototypeId}/{releaseId}', () => {
    expect(releaseKey('9', '31', '77')).toBe('releases/9/31/77');
    expect(releaseFileKey('9', '31', '77', 'assets/app.js')).toBe(
      'releases/9/31/77/assets/app.js',
    );
  });

  it('临时文件、工作目录、清单副本与 trash 各按其形', () => {
    expect(uploadTempKey('128', 'a1b2c3d4')).toBe('tmp/upload-128-a1b2c3d4.zip');
    expect(workDirKey('128')).toBe('tmp/work-128');
    expect(manifestKey('31', '77')).toBe('manifests/31/77.json');
    expect(trashKey('20261006', '31', '77', 'a1b2c3d4')).toBe(
      'trash/20261006/31-77-a1b2c3d4',
    );
  });

  it('ID 段必须是十进制：把编码一类字符串塞进 key 会立刻炸，而不是生成一个越界路径', () => {
    expect(() => releaseKey('../9', '31', '77')).toThrow(
      '存储 key 的 projectId 必须是十进制 ID',
    );
    expect(() => releaseKey('9', '31', '77; rm -rf')).toThrow(
      '存储 key 的 releaseId 必须是十进制 ID',
    );
  });

  it('产物内路径同样受 Zip Slip 口径约束', () => {
    expect(() => releaseFileKey('9', '31', '77', '../evil')).toThrow(
      '产物内路径不合法',
    );
    expect(releaseFileKey('9', '31', '77', './a\\b.html')).toBe(
      'releases/9/31/77/a/b.html',
    );
  });

  it('parseReleaseKey 能从 key 反解三段 ID（GC 的孤儿检测要用）', () => {
    expect(parseReleaseKey('releases/9/31/77')).toEqual({
      projectId: '9',
      prototypeId: '31',
      releaseId: '77',
    });
    expect(parseReleaseKey('releases/9/31')).toBeNull();
    expect(parseReleaseKey('tmp/work-9')).toBeNull();
  });

  it('dateDirOf 输出 yyyyMMdd', () => {
    expect(dateDirOf(new Date(Date.UTC(2026, 9, 6)))).toBe('20261006');
  });
});

async function makeAdapter(): Promise<{
  adapter: LocalStorageAdapter;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'protohub-storage-'));
  const adapter = new LocalStorageAdapter(fakeAppEnv({ STORAGE_ROOT: root }));
  return { adapter, root };
}

describe('LocalStorageAdapter', () => {
  it('启动时自建四个子目录，并判定 tmp/ 与 releases/ 在同一设备', async () => {
    const { adapter, root } = await makeAdapter();
    await adapter.onModuleInit();
    for (const subdir of ['tmp', 'releases', 'manifests', 'trash']) {
      expect(existsSync(join(root, subdir))).toBe(true);
    }
    const check = await adapter.checkMountpoints();
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('同在');
  });

  it('目录缺失时自查报 ok=false（跨挂载点由部署清单核对，这里只保证不静默通过）', async () => {
    const { adapter } = await makeAdapter();
    const check = await adapter.checkMountpoints();
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('不存在');
  });

  it('localPathOf 只在根目录之内给路径', async () => {
    const { adapter, root } = await makeAdapter();
    expect(adapter.localPathOf('releases/9/31/77')).toBe(
      join(root, 'releases/9/31/77'),
    );
    expect(adapter.localPathOf('/etc/passwd')).toBe(join(root, 'etc/passwd'));
    expect(adapter.localPathOf('../escape')).toBeNull();
    expect(adapter.localPathOf('a/../../b')).toBeNull();
    expect(adapter.localPathOf('')).toBeNull();
    expect(adapter.localPathOf('   ')).toBeNull();
    expect(adapter.localPathOf('a\0b')).toBeNull();
    expect(adapter.localPathOf('/')).toBeNull();
  });

  it('requireLocalPath 对越界 key 抛错而不是猜一个路径', async () => {
    const { adapter } = await makeAdapter();
    expect(() => requireLocalPath(adapter, '../x')).toThrow(StorageInvalidKeyError);
  });

  it('putFile 建父目录后落盘，getStream 读回内容', async () => {
    const { adapter, root } = await makeAdapter();
    const src = join(root, 'src.txt');
    await writeFile(src, 'hello');
    await adapter.putFile(src, 'manifests/31/77.json');
    const stream = await adapter.getStream('manifests/31/77.json');
    const chunks = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });

  it('getStream 对不存在与对目录都报 StorageObjectMissingError', async () => {
    const { adapter, root } = await makeAdapter();
    await adapter.onModuleInit();
    await expect(adapter.getStream('releases/9/31/77')).rejects.toThrow(
      StorageObjectMissingError,
    );
    const file = join(root, 'tmp', 'probe.txt');
    await writeFile(file, 'x');
    await expect(adapter.getStream('tmp')).rejects.toThrow(
      StorageObjectMissingError,
    );
  });

  it('moveIntoService 原子地把工作目录纳入服务范围，且绝不覆盖已有目标', async () => {
    const { adapter, root } = await makeAdapter();
    await adapter.onModuleInit();
    const work = join(root, 'tmp', 'work-5');
    await mkdir(join(work, 'assets'), { recursive: true });
    await writeFile(join(work, 'index.html'), '<html></html>');
    await writeFile(join(work, 'assets', 'app.css'), 'body{}');

    await adapter.moveIntoService(work, releaseKey('9', '31', '77'));

    expect(existsSync(work)).toBe(false);
    expect(await readFile(join(root, 'releases/9/31/77/index.html'), 'utf8')).toBe(
      '<html></html>',
    );
    await expect(
      adapter.moveIntoService(work, releaseKey('9', '31', '77')),
    ).rejects.toThrow('拒绝覆盖');
  });

  it('moveToTrash 按 {yyyyMMdd}/{原型ID}-{版本ID}-{随机} 收纳整目录', async () => {
    const { adapter } = await makeAdapter();
    await adapter.onModuleInit();
    const dir = adapter.requireLocalPath(releaseKey('9', '31', '77'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), 'x');

    const movedKey = await adapter.moveToTrash(releaseKey('9', '31', '77'));

    expect(movedKey).toMatch(
      new RegExp(`^trash/\\d{8}/31-77-[0-9a-z]{4,8}$`),
    );
    expect(existsSync(dir)).toBe(false);
    expect(
      existsSync(join(adapter.requireLocalPath(movedKey), 'index.html')),
    ).toBe(true);
  });

  it('deletePrefix 拒绝等于根目录的前缀，其余递归删除', async () => {
    const { adapter, root } = await makeAdapter();
    await adapter.onModuleInit();
    await expect(adapter.deletePrefix('/')).rejects.toThrow(StorageInvalidKeyError);
    await expect(adapter.deletePrefix('./')).rejects.toThrow(StorageInvalidKeyError);
    const doomed = join(root, 'tmp', 'work-9');
    await mkdir(doomed, { recursive: true });
    await writeFile(join(doomed, 'a'), '1');
    await adapter.deletePrefix('tmp/work-9');
    expect(existsSync(doomed)).toBe(false);
  });

  it('exists 对越界 key 直接 false，不去访问根目录之外', async () => {
    const { adapter } = await makeAdapter();
    await expect(adapter.exists('../etc/passwd')).resolves.toBe(false);
  });
});
