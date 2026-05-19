import fs from 'fs';
import http from 'http';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';

const EMACS_CHANNEL_TYPE = 'emacs';
const EMACS_PLATFORM_ID = 'emacs:default';

interface BufferedMessage {
  text: string;
  timestamp: number;
}

export class EmacsBridgeAdapter implements ChannelAdapter {
  name = 'emacs';
  channelType = EMACS_CHANNEL_TYPE;
  supportsThreads = false;

  private server: http.Server | null = null;
  private port: number;
  private authToken: string | null;
  private buffer: BufferedMessage[] = [];
  private setup_: ChannelSetup | null = null;

  constructor(port: number, authToken: string | null) {
    this.port = port;
    this.authToken = authToken;
  }

  async setup(config: ChannelSetup): Promise<void> {
    this.setup_ = config;
    this.ensureClaudeMd();

    config.onMetadata(EMACS_PLATFORM_ID, 'Emacs', false);

    this.server = http.createServer((req, res) => {
      if (!this.checkAuth(req, res)) return;

      const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);

      if (req.method === 'POST' && url.pathname === '/api/message') {
        this.handlePost(req, res);
      } else if (req.method === 'GET' && url.pathname === '/api/messages') {
        this.handlePoll(url, res);
      } else {
        res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        log.info('Emacs channel listening — load emacs/nanoclaw.el to connect', { port: this.port });
        resolve();
      });
      this.server!.once('error', reject);
    });
  }

  async teardown(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      log.info('Emacs channel stopped');
    }
  }

  async deliver(_platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const parsed = message.content as Record<string, unknown>;
    const text = typeof parsed?.text === 'string' ? parsed.text : JSON.stringify(parsed);
    this.buffer.push({ text, timestamp: Date.now() });
    if (this.buffer.length > 200) this.buffer.shift();
    return undefined;
  }

  isConnected(): boolean {
    return this.server?.listening ?? false;
  }

  private checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.authToken) return true;
    const header = req.headers['authorization'] ?? '';
    if (header === `Bearer ${this.authToken}`) return true;
    res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  private handlePost(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body) as { text?: string };
        if (!text?.trim()) {
          res.writeHead(400).end(JSON.stringify({ error: 'text required' }));
          return;
        }

        const timestamp = new Date().toISOString();
        const msgId = `emacs-${Date.now()}`;

        this.setup_?.onInbound(EMACS_PLATFORM_ID, null, {
          id: msgId,
          kind: 'chat',
          content: { text, sender: 'Emacs', senderId: 'emacs' },
          timestamp,
          isMention: true,
          isGroup: false,
        });

        res
          .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ messageId: msgId, timestamp: Date.now() }));

        log.info('Emacs message received', { length: text.length });
      } catch (err) {
        log.error('Emacs channel: failed to parse POST body', { err });
        res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handlePoll(url: URL, res: http.ServerResponse): void {
    const since = parseInt(url.searchParams.get('since') ?? '0', 10);
    const messages = this.buffer.filter((m) => m.timestamp > since);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ messages }));
  }

  private ensureClaudeMd(): void {
    const claudeMd = path.join(GROUPS_DIR, 'emacs', 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) return;
    const dir = path.dirname(claudeMd);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const content = [
      '## Message Formatting',
      '',
      'This is an Emacs channel. Responses are automatically converted from markdown',
      'to org-mode by the bridge before display.',
      '',
      '**Always format responses in standard markdown:**',
      '- `**bold**` not `*bold*`',
      '- `*italic*` not `/italic/`',
      '- `~~strikethrough~~` not `+strikethrough+`',
      '- `` `code` `` not `~code~`',
      '- ` ```lang ` fenced code blocks',
      '- `- ` for bullet points',
      '',
      'Do NOT output org-mode syntax directly. The bridge handles conversion.',
      '',
    ].join('\n');
    try {
      fs.writeFileSync(claudeMd, content, 'utf8');
      log.info('Emacs channel: wrote CLAUDE.md');
    } catch (err) {
      log.warn('Emacs channel: could not write CLAUDE.md', { err });
    }
  }
}

registerChannelAdapter('emacs', {
  factory: () => {
    const envVars = readEnvFile(['EMACS_CHANNEL_PORT', 'EMACS_AUTH_TOKEN']);
    const portStr = process.env.EMACS_CHANNEL_PORT || envVars.EMACS_CHANNEL_PORT || '8766';
    const port = parseInt(portStr, 10);
    const authToken = process.env.EMACS_AUTH_TOKEN || envVars.EMACS_AUTH_TOKEN || null;
    return new EmacsBridgeAdapter(port, authToken);
  },
});
