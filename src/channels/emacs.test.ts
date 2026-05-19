import { execFileSync, execSync } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({ GROUPS_DIR: '/tmp/test-groups' }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

import { EmacsBridgeAdapter } from './emacs.js';
import type { ChannelSetup } from './adapter.js';

function makeSetup(): ChannelSetup & { onInbound: ReturnType<typeof vi.fn>; onMetadata: ReturnType<typeof vi.fn> } {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  } as unknown as ChannelSetup & { onInbound: ReturnType<typeof vi.fn>; onMetadata: ReturnType<typeof vi.fn> };
}

async function req(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode!, data: raw });
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function boundPort(adapter: EmacsBridgeAdapter): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (((adapter as any).server as http.Server).address() as AddressInfo).port;
}

describe('EmacsBridgeAdapter', () => {
  let setup: ReturnType<typeof makeSetup>;
  let adapter: EmacsBridgeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    setup = makeSetup();
    adapter = new EmacsBridgeAdapter(0, null);
  });

  afterEach(async () => {
    if (adapter.isConnected()) await adapter.teardown();
  });

  describe('lifecycle', () => {
    it('isConnected returns false before setup', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('isConnected returns true after setup', async () => {
      await adapter.setup(setup);
      expect(adapter.isConnected()).toBe(true);
    });

    it('isConnected returns false after teardown', async () => {
      await adapter.setup(setup);
      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('teardown is a no-op when not connected', async () => {
      await expect(adapter.teardown()).resolves.not.toThrow();
    });
  });

  describe('POST /api/message', () => {
    let port: number;

    beforeEach(async () => {
      await adapter.setup(setup);
      port = boundPort(adapter);
    });

    it('returns 200 with messageId for valid text', async () => {
      const { status, data } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hello' }));
      expect(status).toBe(200);
      expect(data).toHaveProperty('messageId');
    });

    it('calls onInbound with correct structure', async () => {
      await req(port, 'POST', '/api/message', JSON.stringify({ text: 'ping' }));
      expect(setup.onInbound).toHaveBeenCalledWith(
        'emacs:default',
        null,
        expect.objectContaining({ kind: 'chat', isMention: true }),
      );
    });

    it('returns 400 for empty text', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: '' }));
      expect(status).toBe(400);
    });

    it('returns 400 for invalid JSON', async () => {
      const { status } = await req(port, 'POST', '/api/message', 'not-json');
      expect(status).toBe(400);
    });

    it('returns 404 for unknown paths', async () => {
      const { status } = await req(port, 'POST', '/api/unknown', JSON.stringify({ text: 'hi' }));
      expect(status).toBe(404);
    });
  });

  describe('GET /api/messages', () => {
    let port: number;

    beforeEach(async () => {
      await adapter.setup(setup);
      port = boundPort(adapter);
    });

    it('returns empty messages array initially', async () => {
      const { status, data } = await req(port, 'GET', '/api/messages?since=0');
      expect(status).toBe(200);
      expect(data).toEqual({ messages: [] });
    });

    it('returns messages after deliver', async () => {
      await adapter.deliver('emacs:default', null, { kind: 'chat', content: { text: 'hello back' } });
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect((data as { messages: Array<{ text: string }> }).messages).toHaveLength(1);
      expect((data as { messages: Array<{ text: string }> }).messages[0].text).toBe('hello back');
    });

    it('caps buffer at 200 messages', async () => {
      for (let i = 0; i < 201; i++) {
        await adapter.deliver('emacs:default', null, { kind: 'chat', content: { text: `msg-${i}` } });
      }
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect((data as { messages: unknown[] }).messages).toHaveLength(200);
    });
  });

  describe('authentication', () => {
    let authAdapter: EmacsBridgeAdapter;
    let port: number;

    beforeEach(async () => {
      authAdapter = new EmacsBridgeAdapter(0, 'secret');
      await authAdapter.setup(setup);
      port = boundPort(authAdapter);
    });

    afterEach(async () => {
      if (authAdapter.isConnected()) await authAdapter.teardown();
    });

    it('rejects POST without Authorization header (401)', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }));
      expect(status).toBe(401);
    });

    it('accepts POST with correct Bearer token (200)', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }), {
        Authorization: 'Bearer secret',
      });
      expect(status).toBe(200);
    });

    it('channel without authToken accepts all requests', async () => {
      const noAuth = new EmacsBridgeAdapter(0, null);
      await noAuth.setup(setup);
      const noAuthPort = boundPort(noAuth);
      try {
        const { status } = await req(noAuthPort, 'GET', '/api/messages?since=0');
        expect(status).toBe(200);
      } finally {
        await noAuth.teardown();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// nanoclaw--md-to-org-regex (Emacs Lisp, tested via emacs --batch)

function emacsAvailable(): boolean {
  try {
    execSync('emacs --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function mdToOrg(input: string): string {
  const elFile = path.resolve('emacs/nanoclaw.el');
  const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return execFileSync(
    'emacs',
    ['--batch', '--load', elFile, '--eval', `(princ (nanoclaw--md-to-org-regex "${escaped}"))`],
    { encoding: 'utf8' },
  );
}

describe.skipIf(!emacsAvailable())('nanoclaw--md-to-org-regex', () => {
  it('converts bold **text** → *text*', () => {
    expect(mdToOrg('**hello**')).toBe('*hello*');
  });

  it('converts italic *text* → /text/', () => {
    expect(mdToOrg('*hello*')).toBe('/hello/');
  });

  it('converts strikethrough ~~text~~ → +text+', () => {
    expect(mdToOrg('~~gone~~')).toBe('+gone+');
  });

  it('converts inline code `code` → ~code~', () => {
    expect(mdToOrg('`foo()`')).toBe('~foo()~');
  });

  it('converts fenced code block with language', () => {
    expect(mdToOrg('```typescript\nconst x = 1;\n```')).toBe('#+begin_src typescript\nconst x = 1;\n#+end_src');
  });

  it('converts ## heading → ** heading', () => {
    expect(mdToOrg('## Section')).toBe('** Section');
  });

  it('converts links [text](url) → [[url][text]]', () => {
    expect(mdToOrg('[NanoClaw](https://example.com)')).toBe('[[https://example.com][NanoClaw]]');
  });
});
