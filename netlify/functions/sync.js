// 云同步端点：单人多设备，整份文档 LWW（后写覆盖）合并。
// 身份：用「同步码」作为数据命名空间，替代登录。
// 存储：优先 Netlify Blobs；本地 netlify dev 未关联站点时回退到临时文件（仅本机可用）。
import { getStore } from '@netlify/blobs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STORE_NAME = 'todo-sync';

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers': 'content-type'
};

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
	});
}

function isValidCode(c) {
	return typeof c === 'string' && /^[a-zA-Z0-9_-]{3,40}$/.test(c);
}

function sanitize(c) {
	return String(c).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
}

function fileFor(code) {
	return path.join(os.tmpdir(), `todo-sync-${sanitize(code)}.json`);
}

// 读取云端记录：{ state, updatedAt } | null
async function readCloud(syncCode) {
	const key = `data:${syncCode}`;
	try {
		const store = getStore(STORE_NAME);
		const raw = await store.get(key);
		if (raw != null && raw !== '') {
			try { return JSON.parse(raw); } catch { return null; }
		}
		return null;
	} catch (e) {
		// 本地 dev 缺少 blob 上下文时回退到临时文件，保证本机多标签可测
		try {
			const data = await fs.readFile(fileFor(syncCode), 'utf8');
			return JSON.parse(data);
		} catch {
			return null;
		}
	}
}

async function writeCloud(syncCode, state, updatedAt) {
	const key = `data:${syncCode}`;
	const raw = JSON.stringify({ state, updatedAt });
	try {
		const store = getStore(STORE_NAME);
		await store.set(key, raw);
	} catch (e) {
		try {
			await fs.writeFile(fileFor(syncCode), raw);
		} catch (e2) {
			console.error('写入云存储失败：', e2);
			throw e2;
		}
	}
}

export default async (req, context) => {
	if (req.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: CORS });
	}
	if (req.method !== 'POST') {
		return json({ error: 'method not allowed' }, 405);
	}

	let body;
	try {
		body = await req.json();
	} catch {
		return json({ error: 'invalid json body' }, 400);
	}

	const syncCode = body && body.syncCode;
	if (!isValidCode(syncCode)) {
		return json({ error: 'invalid sync code (3-40 chars, [a-zA-Z0-9_-])' }, 400);
	}

	const dirty = !!body.dirty;
	const lastSyncedAt = Number(body.lastSyncedAt) || 0;
	const payload = body.payload || null;
	const now = Date.now();

	const cloud = await readCloud(syncCode);

	// 还没有任何云端数据
	if (!cloud) {
		if (dirty && payload) {
			await writeCloud(syncCode, payload, now);
			return json({ state: payload, updatedAt: now, action: 'seeded' });
		}
		return json({ state: null, updatedAt: 0, action: 'noop' });
	}

	const cloudChangedSince = cloud.updatedAt > lastSyncedAt;

	if (!dirty) {
		// 本地没改：云端有更新就拉取，否则无操作
		return json(cloudChangedSince
			? { state: cloud.state, updatedAt: cloud.updatedAt, action: 'pulled' }
			: { state: null, updatedAt: cloud.updatedAt, action: 'noop' });
	}

	// 本地改了 → 后同步者覆盖（整份文档 LWW）：无论云端是否变过都推送覆盖
	if (!payload) return json({ error: 'missing payload for push' }, 400);
	await writeCloud(syncCode, payload, now);
	return json({ state: payload, updatedAt: now, action: cloudChangedSince ? 'won' : 'pushed' });
};
