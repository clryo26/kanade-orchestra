const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function create(existingStorage = new Map()) {
    let owner = 'account-generation-a';
    const nodes = new Map();
    const element = () => ({ setAttribute() {}, replaceChildren() {}, appendChild() {}, remove() {} });
    const ctx = {
        crypto: webcrypto, FormData, TextEncoder, Uint8Array,
        localStorage: { getItem: (k) => existingStorage.get(k) || null, setItem: (k, v) => existingStorage.set(k, v) },
        document: { getElementById: (k) => nodes.get(k), createTextNode: (v) => v,
            createElement: element, body: { appendChild: (n) => nodes.set(n.id, n) } },
        portalRuntimeContext: { PORTAL_DEVICE_ID_KEY: 'device' },
        portalCacheIdentity: () => owner,
        invalidateCacheForMutation: vi.fn(async () => {}),
        fileTransport: vi.fn(),
        fetchWithTimeout: (url, options) => url === '/api/portal-file-actor'
            ? Promise.resolve(answer(200, { scope: 'a'.repeat(64) })) : ctx.fileTransport(url, options),
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync('src/static/js/utils/portal_file_operations.js', 'utf8'), ctx);
    return { ctx, storage: existingStorage, setOwner: (v) => { owner = v; } };
}
const answer = (status, data) => ({ status, json: async () => data });

test('malformed 4xx cannot silently discard a pending operation', async () => {
    const { ctx, storage } = create();
    ctx.fileTransport.mockResolvedValue({ status: 400, json: async () => { throw new SyntaxError('invalid'); } });
    await expect(ctx.portalFileRequest('/api/members/1', { method: 'DELETE' })).rejects.toThrow('invalid');
    const id = ctx.fileTransport.mock.calls[0][1].headers['Idempotency-Key'];
    expect(JSON.stringify([...storage.values()])).toContain(id);
});

test('HTML 503 on save and result confirmation retains the same pending operation', async () => {
    const { ctx, storage } = create();
    const html = () => ({ status: 503, json: async () => { throw new SyntaxError('HTML gateway'); } });
    ctx.fileTransport.mockImplementation(async () => html());
    await expect(ctx.portalFileRequest('/api/members/1', { method: 'DELETE' })).rejects.toThrow();
    const firstId = ctx.fileTransport.mock.calls[0][1].headers['Idempotency-Key'];
    const pending = JSON.stringify([...storage.values()]);
    expect(pending).toContain(firstId);
    await expect(ctx.portalFileRequest('/api/members/1', { method: 'DELETE' })).rejects.toThrow();
    expect(ctx.fileTransport.mock.calls[1][0]).toBe(`/api/portal-file-operations/${firstId}`);
    expect(JSON.stringify([...storage.values()])).toBe(pending);
    expect(ctx.invalidateCacheForMutation).not.toHaveBeenCalled();
});

test('lost response and reload resolve the same operation without uploading again', async () => {
    const first = create();
    first.ctx.fileTransport.mockRejectedValueOnce(new Error('connection lost'));
    const options = { method: 'POST', body: JSON.stringify({ title: 'x' }) };
    await expect(first.ctx.portalFileRequest('/api/members', options)).rejects.toThrow('connection lost');
    const operationId = first.ctx.fileTransport.mock.calls[0][1].headers['Idempotency-Key'];
    expect(JSON.stringify([...first.storage.values()])).not.toContain('title');
    const next = create(first.storage);
    next.ctx.fileTransport.mockResolvedValueOnce(answer(200, { result_status: 200, result_body: { id: 1 }, state: 'succeeded' }));
    expect(await next.ctx.portalFileRequest('/api/members', options)).toEqual({ id: 1 });
    expect(next.ctx.fileTransport).toHaveBeenCalledTimes(1);
    expect(next.ctx.fileTransport.mock.calls[0][0]).toBe(`/api/portal-file-operations/${operationId}`);
});

test('unknown outcome with changed attachment cannot allocate another ID', async () => {
    const { ctx, storage } = create();
    ctx.fileTransport.mockRejectedValueOnce(new Error('lost'));
    const form = (text) => { const body = new FormData(); body.append('photo_file', new Blob([text], { type: 'image/png' }), 'same.png'); return { method: 'PUT', body }; };
    await expect(ctx.portalFileRequest('/api/members/1', form('a'))).rejects.toThrow('lost');
    const before = JSON.stringify([...storage.values()]);
    ctx.fileTransport.mockResolvedValueOnce(answer(202, { state: 'processing' }));
    await expect(ctx.portalFileRequest('/api/members/1', form('b'))).rejects.toThrow('前の保存内容');
    expect(JSON.stringify([...storage.values()])).toBe(before);
    expect(ctx.fileTransport).toHaveBeenCalledTimes(2);
});

test('authoritative not-accepted response reuses the durable ID', async () => {
    const { ctx } = create(); const options = { method: 'DELETE' };
    ctx.fileTransport.mockRejectedValueOnce(new Error('lost'));
    await expect(ctx.portalFileRequest('/api/members/1', options)).rejects.toThrow();
    const key = ctx.fileTransport.mock.calls[0][1].headers['Idempotency-Key'];
    ctx.fileTransport.mockResolvedValueOnce(answer(404, { code: 'file_operation_unknown' }))
        .mockResolvedValueOnce(answer(200, { message: 'Deleted' }));
    await ctx.portalFileRequest('/api/members/1', options);
    expect(ctx.fileTransport.mock.calls[2][1].headers['Idempotency-Key']).toBe(key);
});

test('account changes during upload do not apply the previous result', async () => {
    const { ctx, setOwner } = create();
    ctx.fileTransport.mockImplementationOnce(async () => { setOwner('different'); return answer(200, { id: 1 }); });
    await expect(ctx.portalFileRequest('/api/members', { method: 'POST' })).rejects.toThrow('認証情報が変わりました');
    expect(ctx.invalidateCacheForMutation).not.toHaveBeenCalled();
});

test('a fresh login of the same account generation recovers its pending operation', async () => {
    const { ctx, setOwner } = create();
    const options = { method: 'POST', body: JSON.stringify({ name: 'same account' }) };
    ctx.fileTransport.mockRejectedValueOnce(new Error('lost'));
    await expect(ctx.portalFileRequest('/api/members', options)).rejects.toThrow('lost');
    const key = ctx.fileTransport.mock.calls[0][1].headers['Idempotency-Key'];
    // Transport guards use the new authentication, durable identity uses the
    // unchanged opaque account-generation scope returned by the server.
    setOwner('new authentication timestamp');
    ctx.fileTransport.mockResolvedValueOnce(answer(200, { state: 'succeeded', result_status: 200, result_body: { id: 1 } }));
    expect(await ctx.portalFileRequest('/api/members', options)).toEqual({ id: 1 });
    expect(ctx.fileTransport.mock.calls[1][0]).toBe(`/api/portal-file-operations/${key}`);
});

test('expired result does not discard the operation and silently allocate a new ID', async () => {
    const { ctx, storage } = create(); const options = { method: 'POST', body: '{"name":"x"}' };
    ctx.fileTransport.mockRejectedValueOnce(new Error('lost'));
    await expect(ctx.portalFileRequest('/api/members', options)).rejects.toThrow('lost');
    const before = JSON.stringify([...storage.values()]);
    const expired = answer(200, { state: 'succeeded', result_status: 409, result_body: { detail: { code: 'file_operation_expired' } } });
    ctx.fileTransport.mockResolvedValueOnce(expired);
    await expect(ctx.portalFileRequest('/api/members', options)).rejects.toThrow('保存期間');
    expect(JSON.stringify([...storage.values()])).toBe(before);
    ctx.fileTransport.mockResolvedValueOnce(expired);
    await expect(ctx.portalFileRequest('/api/members', { ...options, body: '{"name":"different"}' })).rejects.toThrow('前の保存内容');
    expect(ctx.fileTransport).toHaveBeenCalledTimes(3); // original upload + status queries only
});

test('resume with no pending operations never requests an actor', async () => {
    const { ctx } = create();
    ctx.portalRuntimeContext.appState = { portalAuthVerified: true };
    const transport = vi.spyOn(ctx, 'fetchWithTimeout');
    await ctx.portalFileOperationsResume();
    expect(transport).not.toHaveBeenCalled();
});

test('concurrent resume calls share actor verification but later saves verify again', async () => {
    const storage = new Map([['portalFileOperations:v1', JSON.stringify({ slot: { id: 'pending', ownerHash: 'a'.repeat(64) } })]]);
    const { ctx } = create(storage);
    ctx.portalRuntimeContext.appState = { portalAuthVerified: true };
    const original = ctx.fetchWithTimeout;
    const transport = vi.spyOn(ctx, 'fetchWithTimeout').mockImplementation(async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return original(...args);
    });
    await Promise.all([ctx.portalFileOperationsResume(), ctx.portalFileOperationsResume()]);
    expect(transport.mock.calls.filter(([url]) => url === '/api/portal-file-actor')).toHaveLength(1);
    ctx.fileTransport.mockResolvedValue(answer(200, { id: 1 }));
    await ctx.portalFileRequest('/api/members', { method: 'POST' });
    expect(transport.mock.calls.filter(([url]) => url === '/api/portal-file-actor')).toHaveLength(2);
});

test('resume after an account change does not display the old owner operation', async () => {
    const storage = new Map([['portalFileOperations:v1', JSON.stringify({ slot: { id: 'pending', ownerHash: 'a'.repeat(64) } })]]);
    const { ctx, setOwner } = create(storage);
    ctx.portalRuntimeContext.appState = { portalAuthVerified: true };
    const append = vi.spyOn(ctx.document.body, 'appendChild');
    ctx.fetchWithTimeout = async () => { setOwner('other'); return answer(200, { scope: 'a'.repeat(64) }); };
    await ctx.portalFileOperationsResume();
    expect(append).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get('portalFileOperations:v1')).slot.id).toBe('pending');
});
