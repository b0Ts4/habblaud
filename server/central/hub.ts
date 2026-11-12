// SSE da sede (GET /api/stream): o mesmo protocolo do Habblaud (snapshot, feed, notice), com o escritório de todos
// os membros juntos e, para cada página, só o que a pessoa logada pode fazer (merge.ts, personalize).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeedItem, Notice, OfficeSnapshot } from '../../shared/types';
import { frame } from '../http/sse';
import { mapFeed, mapNotice, mergeSnapshots, personalize, SlotAllocator, type ViewerRights } from './merge';
import type { Members } from './members';

const MAX_BUFFERED = 8 * 1024 * 1024;
const FEED_KEEP = 50;

interface Client {
  res: ServerResponse;
  who: ViewerRights;
}

export class CentralHub {
  private clients = new Set<Client>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private rev = 0;
  private snapshot: OfficeSnapshot;
  private feed: FeedItem[] = [];
  private pendingFeed: FeedItem[] = [];
  /** Avisos ("precisa de você", shell terminou...) vão só para a página do dono dos agentes. */
  private pendingNotices: { member: string; n: Notice }[] = [];
  private readonly slots = new SlotAllocator();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly members: Members,
    private readonly meta: { version: string; startedAt: number; build?: () => string | undefined },
    private readonly throttleMs = 250,
  ) {
    this.snapshot = this.merge();
  }

  start(): void {
    this.unsubscribe = this.members.onUpdate((member, u) => {
      const st = this.members.states().find((m) => m.id === member);
      if (u !== 'gone' && st) {
        for (const f of u.feed ?? []) this.pendingFeed.push(mapFeed(st, f));
        for (const n of u.notices ?? []) this.pendingNotices.push({ member, n: mapNotice(st, n) });
      }
      this.schedule();
    });
    this.pinger = setInterval(() => {
      for (const c of this.clients) this.write(c, ': ping\n\n');
    }, 15_000);
    this.pinger.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  current(who: ViewerRights): OfficeSnapshot {
    return personalize({ ...this.snapshot, serverTime: Date.now() }, who, this.members.state(who.member));
  }

  attach(req: IncomingMessage, res: ServerResponse, who: ViewerRights): void {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const c: Client = { res, who };
    res.write('retry: 2000\n\n');
    res.write(frame('snapshot', this.current(who)));
    res.write(frame('feed', this.feed));
    this.clients.add(c);
    const drop = () => this.clients.delete(c);
    req.on('close', drop);
    res.on('close', drop);
  }

  private merge(): OfficeSnapshot {
    return mergeSnapshots(this.members.states(), {
      rev: ++this.rev,
      now: Date.now(),
      startedAt: this.meta.startedAt,
      version: this.meta.version,
      build: this.meta.build?.(),
      slots: this.slots,
    });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.throttleMs);
    this.timer.unref?.();
  }

  private flush(): void {
    this.snapshot = this.merge();
    const feed = this.pendingFeed.splice(0);
    const notices = this.pendingNotices.splice(0);
    if (feed.length) this.feed = [...this.feed, ...feed].slice(-FEED_KEEP);
    const mine = new Map(this.members.states().map((m) => [m.id, m]));
    for (const c of this.clients) {
      this.write(c, frame('snapshot', personalize(this.snapshot, c.who, mine.get(c.who.member))));
      if (feed.length) this.write(c, frame('feed', feed));
      for (const { member, n } of notices) if (member === c.who.member) this.write(c, frame('notice', n));
    }
  }

  private write(c: Client, chunk: string): void {
    if (c.res.destroyed || c.res.writableEnded || c.res.writableLength > MAX_BUFFERED) {
      this.clients.delete(c);
      c.res.destroy();
      return;
    }
    c.res.write(chunk);
  }
}
