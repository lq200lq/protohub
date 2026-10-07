/**
 * 冒烟流程（迭代实施计划 M5-T7）：登录 → 建项目 → 建原型 → 发布 → 三档访问 → 回滚 → 归档 → 查记录。
 *
 * 走的是**用户那条链路**（真 HTTP、真登录、真上传），所以每一步都必须拿到用户能看到的结果：
 * 门面页的标题、原型本体里的标记、版本号、访问记录行。只调服务层的冒烟证明不了路由与守卫。
 *
 * 前置数据由本文件自己在 *_test 库上准备（seed 幂等 + 一个冒烟账号），不依赖 dev 库；
 * 连接串由环境变量给（scripts/smoke.sh 已经自检过库名），这里再断言一次——直接跑本文件也不会写错库。
 */
import { createPrismaClient } from '../../packages/db/src/index.ts';
import { assertTestDatabase } from '../../packages/db/src/seed/guard.ts';
import { hashPassword } from '../../packages/db/src/seed/password.ts';
import { runSeed } from '../../packages/db/src/seed/index.ts';
import { buildZip } from '../../apps/server/src/testing/zip.fixture.ts';

const baseUrl = (process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3199').replace(/\/+$/, '');
const databaseUrl = process.env.DATABASE_URL ?? '';
const username = process.env.SMOKE_USERNAME ?? 'smoke_admin';
const password = process.env.SMOKE_PASSWORD ?? 'smoke-password';

assertTestDatabase(databaseUrl);

/** 一次运行的唯一后缀：跑多少遍都不会撞上自己上一遍留下的编码 */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const projectCode = `smoke-${RUN}`;
const prototypeCode = `${projectCode}-p01`;
const entryMarker = `SMOKE-ENTRY-${RUN}`;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✔ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/* ---------- 极简 cookie 罐：Node fetch 不自己管 cookie，冒烟得手动带上 ---------- */
const jar = new Map<string, string>();
/** 管理台接口用 Bearer accessToken（登录响应里的那个字段），原型访问才用 Cookie */
let accessToken: null | string = null;
function absorbCookies(response: Response): void {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (!pair || index <= 0) continue;
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}
function cookieHeader(): string {
  return [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
}

interface CallResult {
  body: any;
  status: number;
  text: string;
}

async function call(
  method: string,
  path: string,
  init: { form?: FormData; headers?: Record<string, string>; json?: unknown } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { ...init.headers };
  const cookies = cookieHeader();
  if (cookies) headers.cookie = cookies;
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    body = init.form;
  }
  const response = await fetch(`${baseUrl}${path}`, { body, headers, method });
  absorbCookies(response);
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { body: parsed, status: response.status, text };
}

/** 统一响应信封（后端接口设计 §1.2）：成功时 data 在 `data` 里，失败时错误码在 `error.code` */
function data(result: CallResult): any {
  return result.body && typeof result.body === 'object' ? result.body.data : null;
}

async function prepare(): Promise<void> {
  console.log('… 准备 *_test 库（seed 幂等 + 冒烟账号）');
  const prisma = createPrismaClient(databaseUrl);
  try {
    await prisma.$transaction((tx) => runSeed(tx), { maxWait: 10_000, timeout: 30_000 });
    const superAdminRole = await prisma.sysRole.findFirstOrThrow({
      where: { code: 'super_admin', deletedAt: null },
    });
    const passwordHash = await hashPassword(password);
    const existing = await prisma.sysUser.findFirst({
      where: { deletedAt: null, username },
    });
    if (existing) {
      await prisma.sysUser.update({
        data: {
          forcePasswordChange: false,
          passwordHash,
          status: 1,
          userRoles: { deleteMany: {}, create: { roleId: superAdminRole.id } },
        },
        where: { id: existing.id },
      });
    } else {
      await prisma.sysUser.create({
        data: {
          forcePasswordChange: false,
          passwordHash,
          realName: '冒烟账号',
          remark: 'smoke.sh 建的测试账号，跑在 *_test 库上',
          status: 1,
          username,
          userRoles: { create: { roleId: superAdminRole.id } },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** 一个最小 HTML 原型：index.html + 一个内页，足够覆盖入口与静态资源 */
function prototypeZip(entryHtml: string): Blob {
  const buffer = buildZip([
    { data: Buffer.from(entryHtml, 'utf8'), name: 'index.html' },
    {
      data: Buffer.from('<p>smoke sub page</p>', 'utf8'),
      name: 'pages/detail.html',
    },
    {
      data: Buffer.from('body{font-family:sans-serif}', 'utf8'),
      name: 'assets/app.css',
    },
  ]);
  return new Blob([buffer], { type: 'application/zip' });
}

async function pollTask(taskId: string): Promise<any> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await call('GET', `/api/upload-tasks/${taskId}`);
    const task = data(result);
    if (task?.status === 'success') return task;
    if (task?.status === 'failed' || task?.status === 'canceled') return task;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

/**
 * 收尾：只删自己这次建的行，绝不 truncate（与 dashboard.overview.spec 同一条纪律）。
 * 共享测试库上跑东西，留下的行会绊倒别人的用例——实测就是这么绊倒 seed.spec 的
 * （它的 clearSeedTables 一把 deleteMany 用户，撞上冒烟项目 created_by 的 RESTRICT 外键）。
 * 顺序按外键：访问记录 → 事件 → 版本 → 上传任务 → 原型 → 项目 → 账号。
 */
async function cleanup(): Promise<void> {
  const prisma = createPrismaClient(databaseUrl);
  try {
    // 整个 smoke-* 命名空间都算自己的：中途崩掉的上一次运行留下的行也一并带走（自愈）
    const projects = await prisma.protoProject.findMany({
      select: { id: true },
      where: { code: { startsWith: 'smoke-' } },
    });
    const projectIds = projects.map((row) => row.id);
    const prototypes = await prisma.protoPrototype.findMany({
      select: { id: true },
      where: { projectId: { in: projectIds } },
    });
    const prototypeIds = prototypes.map((row) => row.id);
    const releases = await prisma.protoRelease.findMany({
      select: { id: true },
      where: { prototypeId: { in: prototypeIds } },
    });
    const releaseIds = releases.map((row) => row.id);
    await prisma.protoAccessLog.deleteMany({
      where: { prototypeId: { in: prototypeIds } },
    });
    await prisma.protoReleaseEvent.deleteMany({
      where: { prototypeId: { in: prototypeIds } },
    });
    await prisma.protoRelease.deleteMany({ where: { id: { in: releaseIds } } });
    await prisma.protoUploadTask.deleteMany({
      where: { prototypeId: { in: prototypeIds } },
    });
    await prisma.protoPrototype.deleteMany({ where: { id: { in: prototypeIds } } });
    await prisma.protoProject.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.sysUser.deleteMany({ where: { username } });
    console.log('… 已清理本次冒烟建的行（不 truncate，只删 smoke-* 自己的）');
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  await prepare();

  console.log(`\n冒烟开始（base=${baseUrl}，run=${RUN}）`);

  /* ① 登录 */
  const login = await call('POST', '/api/auth/login', { json: { password, username } });
  const profile = data(login);
  accessToken = profile?.accessToken ?? null;
  check('登录拿到 accessToken', login.status === 200 && typeof profile?.accessToken === 'string');
  check('登录发下会话 Cookie（proto_sess）', jar.has('proto_sess'), [...jar.keys()].join(','));

  const codes = await call('GET', '/api/auth/codes');
  check(
    '权限码包含 proto:prototype:publish',
    Array.isArray(data(codes)) && data(codes).includes('proto:prototype:publish'),
  );

  /* ② 建项目 */
  const project = await call('POST', '/api/projects', {
    json: { code: projectCode, description: 'smoke.sh 建的项目', name: `冒烟项目 ${RUN}` },
  });
  const projectRow = data(project);
  check('建项目成功', project.status < 300 && projectRow?.id !== undefined, project.text.slice(0, 160));
  const projectId = projectRow?.id as string;

  /* ③ 建原型 + 发布 v1（走"已有项目 + 新建原型"这一种受理形态） */
  const form = new FormData();
  form.append('file', prototypeZip(`<html><body><h1>${entryMarker}</h1></body></html>`), 'smoke.zip');
  form.append('projectId', String(projectId));
  form.append('prototype', JSON.stringify({ code: prototypeCode, name: `冒烟原型 ${RUN}` }));
  form.append('note', 'smoke v1');
  const publish = await call('POST', '/api/releases', { form });
  check('发布受理返回 202 + taskId', publish.status === 202 && data(publish)?.taskId !== undefined, publish.text.slice(0, 160));
  const taskId = data(publish)?.taskId as string;
  const task = taskId ? await pollTask(taskId) : null;
  check('发布任务跑成 success', task?.status === 'success', JSON.stringify(task?.error ?? task?.status ?? 'no task'));
  const prototypeId = task?.prototypeId ?? data(publish)?.prototypeId;
  const releaseV1 = task?.release;
  check('v1 版本号为 1', releaseV1?.versionNo === 1);

  const accessPath = (releaseV1?.accessPath ?? `/p/${projectCode}/${prototypeCode}`) as string;

  /* ④ 三档访问 */
  const publicOpen = await call('GET', `${accessPath}/`);
  check(
    '公开档直开拿到原型本体',
    publicOpen.status === 200 && publicOpen.text.includes(entryMarker),
    `status=${publicOpen.status}`,
  );

  const toPassword = await call('PUT', `/api/prototypes/${prototypeId}/policy`, {
    json: { accessMode: 'password', password: 'smoke-pass-1' },
  });
  check('切到密码档', toPassword.status === 200);

  const passwordGate = await call('GET', `${accessPath}/`);
  check(
    '密码档未解锁落到门面页（401 NEED_PASSWORD）',
    passwordGate.status === 401 && passwordGate.text.includes('需要访问密码'),
    `status=${passwordGate.status}`,
  );

  const badUnlock = await call('POST', `/api/access/${projectCode}/${prototypeCode}/unlock`, {
    json: { password: 'wrong-pass' },
  });
  check('错口令被拒（403）', badUnlock.status === 403, `status=${badUnlock.status}`);
  jar.delete(`proto_access_${String(prototypeId)}`);

  const goodUnlock = await call('POST', `/api/access/${projectCode}/${prototypeCode}/unlock`, {
    json: { password: 'smoke-pass-1' },
  });
  check('对口令解锁成功', goodUnlock.status === 200, `status=${goodUnlock.status}`);
  const unlocked = await call('GET', `${accessPath}/`);
  check(
    '解锁后拿到原型本体',
    unlocked.status === 200 && unlocked.text.includes(entryMarker),
    `status=${unlocked.status}`,
  );

  const toMember = await call('PUT', `/api/prototypes/${prototypeId}/policy`, {
    json: { accessMode: 'member' },
  });
  check('切到成员档', toMember.status === 200);
  jar.clear();
  const memberGate = await call('GET', `${accessPath}/`);
  check(
    '成员档未登录落到「需要登录」门面页（403 NEED_LOGIN）',
    memberGate.status === 403 && memberGate.text.includes('需要登录'),
    `status=${memberGate.status}`,
  );
  await call('POST', '/api/auth/login', { json: { password, username } }).then((result) => {
    accessToken = data(result)?.accessToken ?? accessToken;
  });
  const memberOk = await call('GET', `${accessPath}/`);
  check(
    '项目成员打开成员档拿到原型本体',
    memberOk.status === 200 && memberOk.text.includes(entryMarker),
    `status=${memberOk.status}`,
  );

  const toPublic = await call('PUT', `/api/prototypes/${prototypeId}/policy`, {
    json: { accessMode: 'public' },
  });
  check('复原公开档', toPublic.status === 200);

  /* ⑤ 回滚：先发一版不同的内容，再回滚到 v1 */
  const formV2 = new FormData();
  formV2.append(
    'file',
    prototypeZip(`<html><body><h1>${entryMarker}-V2</h1></body></html>`),
    'smoke.zip',
  );
  formV2.append('prototypeId', String(prototypeId));
  formV2.append('note', 'smoke v2');
  const publishV2 = await call('POST', '/api/releases', { form: formV2 });
  const taskV2 = await pollTask(data(publishV2)?.taskId as string);
  check(
    'v2 发布成功',
    taskV2?.status === 'success' && taskV2?.release?.versionNo === 2,
    JSON.stringify(taskV2?.error ?? taskV2?.status ?? 'no task'),
  );

  const rollback = await call('POST', `/api/prototypes/${prototypeId}/rollback`, {
    json: { releaseId: String(releaseV1?.id ?? ''), reason: 'smoke 回滚' },
  });
  check('回滚到 v1 成功', rollback.status === 200, rollback.text.slice(0, 160));
  const afterRollback = await call('GET', `${accessPath}/`);
  check(
    '回滚后链接内容回到 v1',
    afterRollback.status === 200 &&
      afterRollback.text.includes(entryMarker) &&
      !afterRollback.text.includes(`${entryMarker}-V2`),
    `status=${afterRollback.status}`,
  );

  /* ⑥ 归档：链接立刻不可访问 */
  const archive = await call('POST', `/api/prototypes/${prototypeId}/archive`);
  check('归档原型成功', archive.status === 200);
  const archived = await call('GET', `${accessPath}/`);
  check(
    '归档后落到「已下架」门面页（403）',
    archived.status === 403 && archived.text.includes('已下架'),
    `status=${archived.status}`,
  );

  /* ⑦ 查记录：访问记录与工作台都要看得见刚才这些动作。
     访问日志是缓冲写的（机制 §6：上限 500 条或 2 秒才落库），所以这里等它落库再查，
     不然"查不到"是刷新节奏问题、不是没记。 */
  let logItems: any[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const logs = await call('GET', `/api/access-logs?prototypeId=${String(prototypeId)}`);
    logItems = data(logs)?.items ?? [];
    if (logItems.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check('访问记录里有本次访问行', logItems.length > 0, `rows=${String(logItems.length)}`);

  const overview = await call('GET', '/api/dashboard/overview');
  const recent = data(overview)?.recentPrototypes ?? [];
  check(
    '工作台「最近更新的原型」里有这次的原型',
    recent.some((row: any) => row.code === prototypeCode),
  );

  await cleanup();
  console.log(`\n${failures === 0 ? '✔ 冒烟全绿' : `✘ 冒烟失败：${failures} 处判据没过`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
