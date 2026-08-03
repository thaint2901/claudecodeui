import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

// `WORKSPACES_ROOT` (server/shared/utils.ts) is a top-level const evaluated the
// first time that module loads: `process.env.WORKSPACES_ROOT || os.homedir()`.
// It must be set before the first (dynamic) import below. `browse-filesystem`
// and `create-folder` additionally hard-reject any path under a fixed
// system-directory list that includes `/tmp` regardless of WORKSPACES_ROOT, so
// the fixture root is created under the repo checkout instead of os.tmpdir().
const fixturesRoot = await mkdtemp(path.join(process.cwd(), '.files-module-test-'));
process.env.DATABASE_PATH = path.join(fixturesRoot, 'auth.db');
process.env.WORKSPACES_ROOT = fixturesRoot;

const { initializeDatabase, projectsDb } = await import('@/modules/database/index.js');
const { createFilesRouter } = await import('@/modules/files/index.js');

await initializeDatabase();

const projectDir = path.join(fixturesRoot, 'proj');
await mkdir(path.join(projectDir, 'sub'), { recursive: true });
await writeFile(path.join(projectDir, 'hello.txt'), 'hello world\n');
await writeFile(path.join(projectDir, 'sub', 'nested.txt'), 'nested content\n');

const created = projectsDb.createProjectPath(projectDir);
assert.equal(created.outcome, 'created');
assert.ok(created.project);
const projectId = created.project.project_id;

// files.service.js's uploadFilesHandler resolves each relativePaths entry as
// `path.join(resolvedTargetDir, fileName)`, and `resolvedTargetDir` is
// `path.resolve(projectDir)` when no targetPath is supplied (test 18/19
// below never send one). Mirror that exact join so the row-19 traversal test
// asserts the real on-disk location the malicious vector would land at if
// validatePathInProject's guard were ever removed, not just "some path under
// fixturesRoot" (which `../../` does not actually resolve into).
const maliciousUploadRelativePath = '../../evil-traversal.txt';
const escapedUploadDestination = path.join(path.resolve(projectDir), maliciousUploadRelativePath);

const app = express();
// Mirrors server/index.js's express.json config exactly: the `type` guard skips
// multipart/form-data bodies (so multer, not express.json, parses uploads) and
// otherwise requires a JSON content-type.
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    },
}));
app.use('/api', createFilesRouter((_req: Request, _res: Response, next: NextFunction) => next()));
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const api = (p: string) => `http://127.0.0.1:${port}/api${p}`;

test.after(async () => {
    server.close();
    await rm(fixturesRoot, { recursive: true, force: true });
    // Safety net: if the row-19 traversal guard ever regressed, the escaped
    // file would land outside fixturesRoot (in the repo checkout root) and
    // the rm() above would never reach it.
    await rm(escapedUploadDestination, { force: true });
});

async function getJson(p: string): Promise<{ status: number; body: any }> {
    const res = await fetch(api(p));
    const body = await res.json();
    return { status: res.status, body };
}

async function sendJson(method: string, p: string, payload: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(api(p), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const body = await res.json();
    return { status: res.status, body };
}

// 1. read file happy path
test('GET /projects/:id/file reads existing content', async () => {
    const { status, body } = await getJson(`/projects/${projectId}/file?filePath=hello.txt`);
    assert.equal(status, 200);
    assert.equal(body.content, 'hello world\n');
    assert.equal(body.path, path.resolve(projectDir, 'hello.txt'));
});

// 2. read file missing param
test('GET /projects/:id/file 400s when filePath is missing', async () => {
    const { status, body } = await getJson(`/projects/${projectId}/file`);
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'Invalid file path' });
});

// 3. read file traversal
test('GET /projects/:id/file rejects a path traversal escape', async () => {
    // PIN: the handler resolves the relative path against the project root and
    // only checks the result is still prefixed by it (no realpath/symlink
    // check) -- a `../../` escape returns 403, not 404/500.
    const { status, body } = await getJson(
        `/projects/${projectId}/file?filePath=${encodeURIComponent('../../etc/passwd')}`,
    );
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'Path must be under project root' });
});

// 4. save file roundtrip
test('PUT /projects/:id/file writes content a follow-up GET reads back', async () => {
    const putResult = await sendJson('PUT', `/projects/${projectId}/file`, {
        filePath: 'save-roundtrip.txt',
        content: 'updated content',
    });
    assert.equal(putResult.status, 200);
    assert.equal(putResult.body.success, true);
    assert.equal(putResult.body.path, path.resolve(projectDir, 'save-roundtrip.txt'));

    const getResult = await getJson(`/projects/${projectId}/file?filePath=save-roundtrip.txt`);
    assert.equal(getResult.status, 200);
    assert.equal(getResult.body.content, 'updated content');
});

// 5. save file traversal rejected
test('PUT /projects/:id/file rejects a path traversal escape', async () => {
    const { status, body } = await sendJson('PUT', `/projects/${projectId}/file`, {
        filePath: '../../etc/passwd',
        content: 'x',
    });
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'Path must be under project root' });
});

// 6. file tree
test('GET /projects/:id/files returns the tree including nested directory children', async () => {
    const { status, body } = await getJson(`/projects/${projectId}/files`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));

    const helloEntry = body.find((entry: any) => entry.name === 'hello.txt');
    assert.ok(helloEntry, 'hello.txt entry missing from tree');
    assert.equal(helloEntry.type, 'file');

    const subEntry = body.find((entry: any) => entry.name === 'sub');
    assert.ok(subEntry, 'sub directory entry missing from tree');
    assert.equal(subEntry.type, 'directory');
    assert.ok(Array.isArray(subEntry.children));
    const nestedEntry = subEntry.children.find((entry: any) => entry.name === 'nested.txt');
    assert.ok(nestedEntry, 'nested.txt missing from sub directory children');
});

// 7. tree on unknown project
test('GET /projects/:id/files 404s for an unknown project id', async () => {
    const { status, body } = await getJson('/projects/does-not-exist/files');
    assert.equal(status, 404);
    assert.deepEqual(body, { error: 'Project not found' });
});

// 8. files/content raw bytes
test('GET /projects/:id/files/content streams raw bytes with a mime-derived Content-Type', async () => {
    const res = await fetch(api(`/projects/${projectId}/files/content?path=hello.txt`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'hello world\n');
});

// 9. create file
// NOTE: tests 9, 12, 13, and 14 intentionally share one file across the
// default test-runner's sequential execution order (create -> rename ->
// reject a bad rename -> delete); reordering or parallelizing them would
// break the chain.
test('POST /projects/:id/files/create creates a new file on disk', async () => {
    const { status, body } = await sendJson('POST', `/projects/${projectId}/files/create`, {
        path: '',
        type: 'file',
        name: 'created-for-rename.txt',
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.name, 'created-for-rename.txt');
    assert.equal(body.type, 'file');
    assert.equal(await readFile(path.join(projectDir, 'created-for-rename.txt'), 'utf8'), '');
});

// 10. create with bad filename
test('POST /projects/:id/files/create rejects an invalid filename', async () => {
    const { status, body } = await sendJson('POST', `/projects/${projectId}/files/create`, {
        path: '',
        type: 'file',
        name: 'bad:name.txt',
    });
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'Filename contains invalid characters' });
});

// 11. create traversal
test('POST /projects/:id/files/create rejects a parent path escaping the project root', async () => {
    const { status, body } = await sendJson('POST', `/projects/${projectId}/files/create`, {
        path: '../../etc',
        type: 'file',
        name: 'passwd',
    });
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'Path must be under project root' });
});

// 12. rename
test('PUT /projects/:id/files/rename renames on disk', async () => {
    const { status, body } = await sendJson('PUT', `/projects/${projectId}/files/rename`, {
        oldPath: 'created-for-rename.txt',
        newName: 'renamed-file.txt',
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.newName, 'renamed-file.txt');
    await assert.rejects(() => access(path.join(projectDir, 'created-for-rename.txt')));
    await access(path.join(projectDir, 'renamed-file.txt'));
});

// 13. rename to bad name
test('PUT /projects/:id/files/rename rejects an invalid new name', async () => {
    const { status, body } = await sendJson('PUT', `/projects/${projectId}/files/rename`, {
        oldPath: 'renamed-file.txt',
        newName: 'bad:name.txt',
    });
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'Filename contains invalid characters' });
});

// 14. delete file
test('DELETE /projects/:id/files removes the file from disk', async () => {
    const { status, body } = await sendJson('DELETE', `/projects/${projectId}/files`, {
        path: 'renamed-file.txt',
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.type, 'file');
    await assert.rejects(() => access(path.join(projectDir, 'renamed-file.txt')));
});

// 15. delete traversal
test('DELETE /projects/:id/files rejects a path traversal escape', async () => {
    const { status, body } = await sendJson('DELETE', `/projects/${projectId}/files`, {
        path: '../../etc/passwd',
    });
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'Path must be under project root' });
});

// 16. browse-filesystem
test('GET /browse-filesystem lists directory contents and 404s a nonexistent path', async () => {
    // PIN: the query parameter is literally named `path` (destructured as
    // `{ path: dirPath }` in the handler), not `dirPath` as the brief's sketch
    // suggested.
    const resolvedFixturesRoot = await realpath(fixturesRoot);
    const okResult = await getJson(`/browse-filesystem?path=${encodeURIComponent(fixturesRoot)}`);
    assert.equal(okResult.status, 200);
    assert.equal(okResult.body.path, resolvedFixturesRoot);
    const projEntry = okResult.body.suggestions.find((entry: any) => entry.name === 'proj');
    assert.ok(projEntry, 'proj directory missing from suggestions');
    assert.equal(projEntry.type, 'directory');

    const missingResult = await getJson(
        `/browse-filesystem?path=${encodeURIComponent(path.join(fixturesRoot, 'does-not-exist'))}`,
    );
    assert.equal(missingResult.status, 404);
    assert.deepEqual(missingResult.body, { error: 'Directory not accessible' });
});

// 17. create-folder
test('POST /create-folder creates a directory inside the workspace and rejects a system path', async () => {
    const targetPath = path.join(fixturesRoot, 'new-folder');
    const { status, body } = await sendJson('POST', '/create-folder', { path: targetPath });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok((await stat(targetPath)).isDirectory());

    // PIN: `/etc` is in the fixed FORBIDDEN_WORKSPACE_PATHS list, checked before
    // (and independent of) the WORKSPACES_ROOT containment check.
    const forbidden = await sendJson('POST', '/create-folder', { path: '/etc/new-folder' });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(forbidden.body, { error: 'Cannot create workspace in system directory: /etc' });
});

// 18. upload happy path
test('POST /projects/:id/files/upload writes uploaded files under the project root', async () => {
    const form = new FormData();
    form.append('files', new Blob(['uploaded content'], { type: 'text/plain' }), 'upload-test.txt');

    const res = await fetch(api(`/projects/${projectId}/files/upload`), { method: 'POST', body: form });
    const body: any = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.uploadedCount, 1);
    assert.equal(body.files[0].name, 'upload-test.txt');
    assert.equal(await readFile(path.join(projectDir, 'upload-test.txt'), 'utf8'), 'uploaded content');
});

// 19. upload traversal filename
test('POST /projects/:id/files/upload drops a file whose relativePaths target escapes the project root', async () => {
    // PIN: unlike every other traversal case in this file, this handler does NOT
    // reject the request with a 4xx -- it silently skips the offending file
    // (validatePathInProject fails, the temp copy is unlinked, the loop
    // `continue`s) and still responds 200 with an accurate uploadedCount of 0.
    const form = new FormData();
    form.append('files', new Blob(['malicious content'], { type: 'text/plain' }), 'ignored-name.txt');
    form.append('relativePaths', JSON.stringify([maliciousUploadRelativePath]));

    const res = await fetch(api(`/projects/${projectId}/files/upload`), { method: 'POST', body: form });
    const body: any = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.uploadedCount, 0);
    assert.deepEqual(body.files, []);
    assert.equal(body.requestedFileCount, 1);
    // Real destination `../../evil-traversal.txt` would land at if the guard
    // were absent -- see escapedUploadDestination's derivation above. (Asserting
    // non-existence at `fixturesRoot/evil-traversal.txt` would be a false
    // guard: that `../../` escape never resolves under fixturesRoot at all.)
    await assert.rejects(() => access(escapedUploadDestination));
});
